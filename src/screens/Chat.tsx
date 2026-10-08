import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { wallet, formatKrx } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import { MODELS, ModelName, MIN_AI_REQUEST_PRIORITY_FEE, h14ActivationDaa } from "../lib/aiRequest";
import { AiProviders, explorerApi, explorerBase } from "../lib/explorerApi";
import {
  bytesToHex, cohortSeed, compressPrompt, deriveRootKey, hexToBytes, maxPrivatePromptLen, maxRequestPayloadLen, openResponse, sealRecipients, sealRequest,
} from "../lib/privateInference";
import { byteLength, ChatMessage, composePrompt, Conversation, loadConversations, saveConversations } from "../lib/chatStore";
import { buildKeryxContext, fetchLiveFacts, isKeryxQuestion, namesKeryx } from "../lib/keryxContext";
import { replyLanguageLine } from "../lib/language";
import {
  buildWebContext, DEFAULT_WEB_ENDPOINT, isLongMessage, isSearchRequest, isWebQuestion, loadWebMode, saveWebMode, searchWeb, stripWebPrefix, WebMode,
} from "../lib/webSearch";

const MIN_PRIORITY_FEE_SOMPI = Number(MIN_AI_REQUEST_PRIORITY_FEE);
// Context each tier's engine is expected to hold, by tier index.
const CONTEXT_TOKENS = [32_768, 32_768, 32_768, 32_768, 32_768];
const FLAT_CAP_TOKENS = 2_048;
// Tokens kept free beside the prompt and the answer (chat template, tokenizer drift).
const CONTEXT_MARGIN_TOKENS = 512;
const BYTES_PER_TOKEN = 3;
const CONTINUE_PROMPT = "Continue exactly where you stopped.";
const FACTS_BUDGET_BYTES = 3_500;
const WEB_BUDGET_BYTES = 2_600;
const WEB_MIN_BYTES = 700;
const POLL_MS = 2_000;
// A cohort seen this recently still counts when a fresh read comes back empty for a moment.
const COHORT_MEMORY_MS = 5 * 60 * 1000;
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;

// H14 lineup; the index is the tier.
const LINEUP: ModelName[] = ["qwen3.5-9b-abliterated", "glm-4-9b-0414", "gemma-4-12b-abliterated", "qwen3.8-27b", "kimi-linear-48b"];
const shortLabel = (name: string) => (MODELS[name as ModelName]?.label ?? name).replace(/ \(uncensored\)$/, "");

// The models respell the ticker when it recurs in the prompt (KRC, KRIX, KRYX, KXR, KTX…); shown as KRX.
const TICKER_RESPELLINGS = /(?<![\p{L}\d])(T?)K(?:R[A-Z]{1,2}|[A-Z]?X|[A-Z]R[A-Z]?)(?![\p{L}\d])/gu;
const KNOWN_ACRONYMS = new Set(["KYC", "KPI", "KVM", "KHZ", "KWH", "KMH", "KGS", "KEY", "KIT"]);
function normalizeTicker(text: string): string {
  return text
    .replace(/\b(T-)?K-R-X\b/g, (_m: string, t: string | undefined) => (t ? "TKRX" : "KRX"))
    .replace(TICKER_RESPELLINGS, (word: string, t: string) =>
      KNOWN_ACRONYMS.has(word.replace(/^T/, "")) || word === `${t}KRX` ? word : `${t}KRX`,
    );
}
const rewardFor = (tier: number) => Number(MODELS[LINEUP[tier]].flatRewardSompi);
const costFor = (tier: number) => rewardFor(tier) + MIN_PRIORITY_FEE_SOMPI;
const flatCapFor = (tier: number, promptBytes: number) =>
  Math.max(256, Math.min(FLAT_CAP_TOKENS, CONTEXT_TOKENS[tier] - Math.ceil(promptBytes / BYTES_PER_TOKEN) - 128));
/** Prompt bytes a tier's context takes next to a full-length answer. */
const promptBudgetFor = (tier: number) => (CONTEXT_TOKENS[tier] - FLAT_CAP_TOKENS - CONTEXT_MARGIN_TOKENS) * BYTES_PER_TOKEN;
const newId = () => bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
const titleOf = (question: string) => (question.length > 42 ? question.slice(0, 42).trimEnd() + "…" : question);
const krx = (sompi: number) => formatKrx(BigInt(sompi));

/** An answer that used most of its cap and does not end on closing punctuation was likely cut. */
function looksTruncated(m: ChatMessage): boolean {
  const answer = (m.answer ?? "").trim();
  if (!answer) return false;
  return answer.split(/\s+/).length >= m.maxTokens * 0.5 && !/[.!?…。:;»"'”’)\]`*|]$/.test(answer);
}

function minersOf(providers: AiProviders | null, tier: number): number | null {
  if (!providers) return null;
  return new Set(providers.cohort.filter((p) => p.tier === tier).map((p) => p.escrow_pubkey)).size;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

const markdownComponents = {
  p: (props: React.ComponentProps<"p">) => <p className="mb-3 last:mb-0" {...props} />,
  ul: (props: React.ComponentProps<"ul">) => <ul className="mb-3 list-disc pl-5 last:mb-0" {...props} />,
  ol: (props: React.ComponentProps<"ol">) => <ol className="mb-3 list-decimal pl-5 last:mb-0" {...props} />,
  h1: (props: React.ComponentProps<"h1">) => <h1 className="mb-2 text-base font-bold" {...props} />,
  h2: (props: React.ComponentProps<"h2">) => <h2 className="mb-2 text-base font-bold" {...props} />,
  h3: (props: React.ComponentProps<"h3">) => <h3 className="mb-2 font-bold" {...props} />,
  a: (props: React.ComponentProps<"a">) => (
    <a className="text-keryx-bright underline" target="_blank" rel="noopener noreferrer" {...props} />
  ),
  pre: (props: React.ComponentProps<"pre">) => (
    <pre className="mb-3 overflow-x-auto rounded-sm border border-keryx-border bg-keryx-surface p-3 text-xs last:mb-0" {...props} />
  ),
  code: (props: React.ComponentProps<"code">) => <code className="text-keryx-bright" {...props} />,
  table: (props: React.ComponentProps<"table">) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: (props: React.ComponentProps<"th">) => <th className="border border-keryx-border px-2 py-1 text-left" {...props} />,
  td: (props: React.ComponentProps<"td">) => <td className="border border-keryx-border px-2 py-1" {...props} />,
};

export function Chat({ onClose }: { onClose: () => void }) {
  const w = useWalletState();
  const networkId = w.networkId;
  const api = useMemo(() => explorerApi(networkId), [networkId]);
  const explorer = explorerBase(networkId);

  const primaryAddress = w.receiveAddresses[0] ?? null;
  const [walletKey, setWalletKey] = useState<{ address: string; privateKeyHex: string } | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  useEffect(() => {
    try {
      setWalletKey(wallet.chatKey());
      setKeyError(null);
    } catch (e) {
      setWalletKey(null);
      setKeyError(e instanceof Error ? e.message : String(e));
    }
  }, [networkId, primaryAddress]);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tier, setTier] = useState(3);
  const [tierChosen, setTierChosen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [webMode, setWebMode] = useState<WebMode>(loadWebMode);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AiProviders | null>(null);
  const lastCohort = useRef<Map<number, { cohort: string[]; window: string[]; at: number }>>(new Map());
  const [nowMs, setNowMs] = useState(0);

  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const threadEnd = useRef<HTMLDivElement>(null);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const hasPending = conversations.some((c) => c.messages.some((m) => m.status === "pending"));

  // ── Local history ──────────────────────────────────────────────────────────

  useEffect(() => {
    setLoaded(false);
    setConversations([]);
    setActiveId(null);
    if (!walletKey) return;
    let cancelled = false;
    loadConversations(walletKey.address, walletKey.privateKeyHex).then((stored) => {
      if (cancelled) return;
      setConversations(stored);
      setActiveId(stored[0]?.id ?? null);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [walletKey]);

  useEffect(() => {
    if (!walletKey || !loaded) return;
    saveConversations(walletKey.address, walletKey.privateKeyHex, conversations).catch(() => {
      setError("The wallet refused to store the conversation: it will be lost when the chat closes.");
    });
  }, [conversations, walletKey, loaded]);

  // ── Chain state ────────────────────────────────────────────────────────────

  useEffect(() => {
    const load = () => {
      api
        .aiProviders()
        .then((p) => {
          setProviders(p);
          for (let t = 0; t < LINEUP.length; t++) {
            const cohort = p.cohort.filter((x) => x.tier === t).map((x) => x.escrow_pubkey);
            if (cohort.length > 0)
              lastCohort.current.set(t, { cohort, window: p.window.filter((x) => x.tier === t).map((x) => x.escrow_pubkey), at: Date.now() });
          }
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [api]);

  // Until the user picks one, follow the largest model that has miners.
  useEffect(() => {
    if (tierChosen || !providers) return;
    for (let t = LINEUP.length - 1; t >= 0; t--) {
      if ((minersOf(providers, t) ?? 0) > 0) {
        setTier(t);
        return;
      }
    }
  }, [providers, tierChosen]);

  // ── Answers ────────────────────────────────────────────────────────────────

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setConversations((all) =>
      all.map((c) =>
        c.messages.some((m) => m.id === id)
          ? { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }
          : c,
      ),
    );
  }, []);

  useEffect(() => {
    if (!walletKey || !hasPending) return;
    const privateKeyHex = walletKey.privateKeyHex;
    const tick = async () => {
      setNowMs(Date.now());
      const pending = conversationsRef.current.flatMap((c) => c.messages).filter((m) => m.status === "pending");
      for (const message of pending) {
        const result = await api.inferenceResult(message.id).catch(() => null);
        const responses = result?.sealed_responses ?? [];
        if (responses.length > 0) {
          const rootKey = deriveRootKey(privateKeyHex, hexToBytes(message.seedHex));
          let unreadable: string | null = null;
          let opened = false;
          for (const response of responses) {
            try {
              const answer = openResponse(rootKey, message.id, response.responder_pubkey, hexToBytes(response.body));
              patchMessage(message.id, { status: "answered", answer, responder: response.responder_pubkey, answeredAt: Date.now() });
              opened = true;
              break;
            } catch {
              // A miner that could not open the request says so in a body that is not an envelope.
              unreadable = new TextDecoder().decode(hexToBytes(response.body)).slice(0, 300);
            }
          }
          if (opened) continue;
          if (Date.now() - message.sentAt > PENDING_TIMEOUT_MS) {
            patchMessage(message.id, { status: "failed", error: `No answer could be opened. A miner replied: ${unreadable ?? "?"}` });
          }
        } else if (Date.now() - message.sentAt > PENDING_TIMEOUT_MS) {
          patchMessage(message.id, { status: "failed", error: "No miner answered in time." });
        }
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [walletKey, hasPending, patchMessage, api]);

  const messageCount = active?.messages.length ?? 0;
  const lastStatus = active?.messages[messageCount - 1]?.status;
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messageCount, lastStatus]);

  // ── Sending ────────────────────────────────────────────────────────────────

  const daa = w.nodeDaa != null ? Number(w.nodeDaa) : 0;
  const gateDaa = h14ActivationDaa(networkId);
  const gateOpen = w.nodeDaa != null && BigInt(w.nodeDaa) >= gateDaa;
  const cost = costFor(tier);
  const miners = minersOf(providers, tier);
  const balance = w.balance.mature;
  const hasFunds = balance > BigInt(cost);
  const canSend = !!walletKey && draft.trim().length > 0 && !sending && gateOpen && (miners ?? 0) > 0 && hasFunds;

  // `override` sends a fixed question with a fixed cap (the Continue button) instead of the draft.
  const send = useCallback(
    async (override?: { question: string }) => {
      if (!walletKey) return;
      const question = (override?.question ?? stripWebPrefix(draft)).trim();
      const requestReward = rewardFor(tier);
      const requestCost = requestReward + MIN_PRIORITY_FEE_SOMPI;
      if (!question) return;
      setSending(true);
      setError(null);
      try {
        const [info, firstLive] = await Promise.all([api.info().catch(() => null), api.aiProviders()]);
        // The cohort read can come back empty for a moment; ask again before giving up.
        let live = firstLive;
        for (let attempt = 0; attempt < 2 && !live.cohort.some((p) => p.tier === tier); attempt++) {
          await new Promise((r) => setTimeout(r, 1_000));
          live = await api.aiProviders();
        }
        setProviders(live);
        const keysOf = (list: AiProviders["cohort"]) => list.filter((p) => p.tier === tier).map((p) => p.escrow_pubkey);
        let cohort = keysOf(live.cohort);
        let windowKeys = keysOf(live.window);
        if (cohort.length > 0) {
          lastCohort.current.set(tier, { cohort, window: windowKeys, at: Date.now() });
        } else {
          const remembered = lastCohort.current.get(tier);
          if (remembered && Date.now() - remembered.at < COHORT_MEMORY_MS) {
            cohort = remembered.cohort;
            windowKeys = remembered.window;
          }
        }
        if (cohort.length === 0) {
          throw new Error(`No miner is serving ${shortLabel(LINEUP[tier])} right now. Nothing has been sent.`);
        }
        const contextRoom = promptBudgetFor(tier) - 1_024;
        if (byteLength(question) > contextRoom) {
          throw new Error(
            `This message is too long for ${shortLabel(LINEUP[tier])}: ${byteLength(question)} bytes, about ${contextRoom} fit in its context. Nothing has been sent.`,
          );
        }

        let seed: Uint8Array = new Uint8Array();
        let recipients: string[] = [];
        let tokens = FLAT_CAP_TOKENS;
        let used = 0;
        let factsBlock = "";
        let sources: ChatMessage["sources"];

        const { txId } = await wallet.submitSealedInference({
          rewardSompi: BigInt(requestReward),
          feeSompi: BigInt(MIN_PRIORITY_FEE_SOMPI),
          seal: async (inputs) => {
            // The first input seeds the target cohort, so the inputs are fixed before sealing.
            seed = cohortSeed(inputs[0].transactionId, inputs[0].index);
            recipients = sealRecipients(seed, cohort, windowKeys);
            const room = maxPrivatePromptLen(recipients.length, maxRequestPayloadLen(inputs.length));
            if (byteLength(question) > room && (await compressPrompt(question)).length > room) {
              throw new Error(`This message is too long: ${byteLength(question)} bytes, too large even compressed. Nothing has been sent.`);
            }
            const history = (conversationsRef.current.find((c) => c.id === activeId)?.messages ?? [])
              .filter((m) => m.status === "answered" && m.answer)
              .map((m) => ({ question: m.question, answer: m.answer as string }));
            // Facts about Keryx ride along silently when the question, or the last exchange, is about it.
            const withFacts = !override && isKeryxQuestion(question, history[history.length - 1]);
            let promptBudget = promptBudgetFor(tier);
            if (withFacts) {
              const liveFacts = await fetchLiveFacts(api, question, live, info);
              factsBlock = buildKeryxContext(question, liveFacts, Math.min(FACTS_BUDGET_BYTES, promptBudget - byteLength(question) - 256));
              promptBudget -= byteLength(factsBlock);
            }
            // Web results ride along when the question asks for them (or the user forces it); the
            // search query leaves the wallet in clear through the relay, the request itself stays sealed.
            let webBlock = "";
            const lastMessage = conversationsRef.current.find((c) => c.id === activeId)?.messages.slice(-1)[0];
            const threadOnWeb = !!lastMessage?.sources?.length;
            // A question naming Keryx is answered from the Keryx facts unless a search is asked for.
            const keryxOnly = namesKeryx(draft) && !isSearchRequest(draft) && stripWebPrefix(draft) === draft.trim();
            const withWeb =
              !override &&
              webMode !== "off" &&
              (webMode === "on" || (!keryxOnly && (isWebQuestion(draft) || (threadOnWeb && !isLongMessage(draft)))));
            if (withWeb) {
              const webCap = Math.min(WEB_BUDGET_BYTES, promptBudget - byteLength(question) - 256);
              if (webCap >= WEB_MIN_BYTES) {
                setSearching(true);
                try {
                  const followUp = threadOnWeb || isSearchRequest(draft);
                  const found = await searchWeb(draft, DEFAULT_WEB_ENDPOINT, followUp ? lastMessage?.question : undefined);
                  const built = buildWebContext(found, webCap);
                  webBlock = built.block;
                  if (built.sources.length > 0) sources = built.sources;
                } catch (e) {
                  // The answer still goes out without the web; the user sees why.
                  setError(`Web search skipped: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setSearching(false);
                }
                promptBudget -= byteLength(webBlock);
              }
            }
            // The miner is stateless and the model has no clock: every prompt opens with the time.
            const clock = new Date();
            const dateLine =
              `Current date and time: ${clock.toUTCString().replace(/:\d\d GMT$/, " UTC")} (${clock.toISOString().slice(0, 10)}). ` +
              "Mention it only when the question is about the date, the day or the time.\n\n";
            // Placed right before the conversation: the blocks above are in English, the user may not be.
            const guidance =
              "Reply in the language of the user's message below, whatever the language of the material above. " +
              "Do not introduce yourself and do not describe the Keryx network unless the user asks about it. " +
              (webBlock
                ? "\n\n"
                : "No web search was made for this message: never claim you searched the web, cite online sources " +
                  "or give live figures you do not have.\n\n");
            // Last line of the prompt: the reply language, written in that language.
            const replyIn = replyLanguageLine(question);
            const tail = replyIn ? `\n\n${replyIn}` : "";
            promptBudget -= byteLength(dateLine) + byteLength(guidance) + byteLength(tail);
            const head = dateLine + factsBlock + webBlock + guidance;
            let composed = composePrompt(history, question, promptBudget, !!override);
            let prompt = head + composed.prompt + tail;
            // Past the payload room the prompt goes compressed; still too large, older exchanges give way.
            let encoded: string | Uint8Array = prompt;
            while (byteLength(prompt) > room) {
              encoded = await compressPrompt(prompt);
              if (encoded.length <= room) break;
              if (composed.used === 0) throw new Error("This message and its context are too large even compressed. Nothing has been sent.");
              promptBudget = Math.floor(byteLength(composed.prompt) * Math.min(0.9, room / encoded.length));
              composed = composePrompt(history, question, promptBudget, !!override);
              prompt = head + composed.prompt + tail;
              encoded = prompt;
            }
            used = composed.used;
            tokens = flatCapFor(tier, byteLength(prompt));
            return sealRequest({
              modelIdHex: MODELS[LINEUP[tier]].modelIdHex,
              maxTokens: tokens,
              inferenceRewardSompi: requestReward,
              priorityFeeSompi: MIN_PRIORITY_FEE_SOMPI,
              prompt: encoded,
              recipientsHex: recipients,
              rootKey: deriveRootKey(walletKey.privateKeyHex, seed),
            });
          },
        });

        const message: ChatMessage = {
          id: txId,
          question,
          model: LINEUP[tier],
          maxTokens: tokens,
          costSompi: requestCost,
          sentAt: Date.now(),
          seedHex: bytesToHex(seed),
          recipients: recipients.length,
          contextUsed: used,
          status: "pending",
          factsBytes: byteLength(factsBlock) || undefined,
          sources,
        };
        const now = Date.now();
        const conversationId = activeId ?? newId();
        setConversations((all) =>
          all.some((c) => c.id === conversationId)
            ? all.map((c) => (c.id === conversationId ? { ...c, updatedAt: now, messages: [...c.messages, message] } : c))
            : [{ id: conversationId, title: titleOf(question), createdAt: now, updatedAt: now, messages: [message] }, ...all],
        );
        setActiveId(conversationId);
        if (!override) setDraft("");
        setNowMs(now);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setSending(false);
    },
    [walletKey, draft, tier, activeId, webMode, api],
  );

  const removeConversation = (id: string) => {
    setConversations((all) => all.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-keryx-bg text-sm">
      <header className="flex items-center justify-between border-b border-keryx-border px-5 py-3">
        <div>
          <h2 className="text-lg font-bold text-keryx-green">Inference</h2>
          <p className="text-xs text-keryx-dim">Sealed end to end: only the miners of the model you pick can read your message, only you can read the answer.</p>
        </div>
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Conversations ─────────────────────────────────────────────────── */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-keryx-border bg-keryx-surface">
          <div className="p-3">
            <button
              onClick={() => {
                setActiveId(null);
                setError(null);
              }}
              className="btn-ghost w-full py-2 text-xs"
            >
              + New chat
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
            {sorted.length === 0 && <div className="px-2 py-4 text-xs text-keryx-dim">No conversation yet.</div>}
            {sorted.map((c) => (
              <div key={c.id} className={`group flex items-center rounded-sm ${c.id === activeId ? "bg-keryx-bg" : ""}`}>
                <button
                  onClick={() => {
                    setActiveId(c.id);
                    setError(null);
                  }}
                  className={`min-w-0 flex-1 truncate px-2 py-2 text-left text-xs ${c.id === activeId ? "text-keryx-bright" : "text-keryx-text"}`}
                  title={c.title}
                >
                  {c.title}
                </button>
                <button
                  onClick={() => removeConversation(c.id)}
                  className="px-2 text-xs text-keryx-dim opacity-0 hover:!opacity-100 group-hover:opacity-70"
                  aria-label={`Delete conversation ${c.title}`}
                  title="Delete from this wallet"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-keryx-border p-3 text-xs text-keryx-dim">
            <span className="text-keryx-mid">Sealed end to end</span>
            <span>History is kept in this wallet only, encrypted.</span>
            {walletKey && (
              <span className="truncate" title={walletKey.address}>
                {walletKey.address}
              </span>
            )}
            <span className={hasFunds ? "text-keryx-mid" : "text-keryx-error"}>{formatKrx(balance)} KRX</span>
          </div>
        </aside>

        {/* ── Thread ────────────────────────────────────────────────────────── */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-keryx-border px-4 py-2.5 text-xs">
            <label className="flex items-center gap-2 text-keryx-dim">
              Model
              <select
                value={tier}
                onChange={(e) => {
                  setTier(Number(e.target.value));
                  setTierChosen(true);
                }}
                className="cursor-pointer rounded-sm border border-keryx-border bg-keryx-bg px-2 py-1.5 text-keryx-mid focus:outline-none"
              >
                {LINEUP.map((name, t) => {
                  const n = minersOf(providers, t);
                  return (
                    <option key={name} value={t}>
                      {shortLabel(name)} · {n === null ? "…" : n === 0 ? "no miner" : `${n} miner${n > 1 ? "s" : ""}`}
                    </option>
                  );
                })}
              </select>
            </label>
            <span className="ml-auto text-keryx-dim">
              <span className="text-keryx-mid">{krx(cost)} KRX</span> per message
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
              {!active && (
                <div className="flex flex-col gap-3 py-16 text-center text-keryx-dim">
                  <div className="text-xl font-bold tracking-widest text-keryx-bright">ASK KERYX</div>
                  <div>Your message is sealed to the miners of {shortLabel(LINEUP[tier])}. Only you can read the answer.</div>
                </div>
              )}
              {active?.messages.map((m) => (
                <div key={m.id} className="flex flex-col gap-2">
                  <div className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-sm border border-keryx-border bg-keryx-surface px-3 py-2 text-keryx-text">
                    {m.question}
                  </div>
                  {m.status === "answered" && (
                    <div className="flex max-w-full flex-col gap-1.5">
                      <div className="break-words leading-relaxed text-keryx-bright">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents as never}>
                          {normalizeTicker(m.answer ?? "")}
                        </ReactMarkdown>
                      </div>
                      <div className="text-[11px] text-keryx-dim">
                        {shortLabel(m.model)} · {krx(m.costSompi)} KRX
                        {m.answeredAt ? ` · answered in ${elapsed(m.answeredAt - m.sentAt)}` : ""}
                        {m.contextUsed > 0 ? ` · ${m.contextUsed} earlier exchange${m.contextUsed > 1 ? "s" : ""} as context` : ""}
                        {" · "}
                        <a href={`${explorer}/tx/${m.id}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          request {m.id.slice(0, 10)}…
                        </a>
                      </div>
                      {m.sources && m.sources.length > 0 && (
                        <ol className="flex flex-col gap-0.5 text-[11px] text-keryx-dim">
                          {m.sources.map((src, i) => (
                            <li key={src.url} className="truncate">
                              [{i + 1}]{" "}
                              <a href={src.url} target="_blank" rel="noopener noreferrer" className="hover:underline" title={src.url}>
                                {src.title}
                              </a>
                            </li>
                          ))}
                        </ol>
                      )}
                      {m.id === active.messages[active.messages.length - 1].id &&
                        looksTruncated(m) &&
                        (() => {
                          const ready = !sending && gateOpen && (miners ?? 0) > 0;
                          return (
                            <button
                              onClick={() => send({ question: CONTINUE_PROMPT })}
                              disabled={!ready}
                              className={`btn-ghost mt-1 self-start px-3 py-1.5 text-xs ${ready ? "text-keryx-bright" : "text-keryx-dim"}`}
                              title="The answer looks cut at its token cap. This sends a follow-up with the conversation as context."
                            >
                              Continue ↓ · {krx(cost)} KRX
                            </button>
                          );
                        })()}
                    </div>
                  )}
                  {m.status === "pending" && (
                    <div className="animate-pulse text-xs text-keryx-mid">
                      Sealed to {m.recipients} miner{m.recipients > 1 ? "s" : ""} of {shortLabel(m.model)}
                      {m.sources ? ` · ${m.sources.length} web source${m.sources.length > 1 ? "s" : ""} attached` : ""} · waiting for the
                      answer… {nowMs > m.sentAt ? elapsed(nowMs - m.sentAt) : ""}
                    </div>
                  )}
                  {m.status === "failed" && (
                    <div className="text-xs text-keryx-error">
                      {m.error ?? "No answer."}{" "}
                      <a href={`${explorer}/tx/${m.id}`} target="_blank" rel="noopener noreferrer" className="underline">
                        request {m.id.slice(0, 10)}…
                      </a>
                    </div>
                  )}
                </div>
              ))}
              <div ref={threadEnd} />
            </div>
          </div>

          <div className="border-t border-keryx-border px-4 py-3">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {keyError && <div className="text-xs text-keryx-error">{keyError}</div>}
              {!gateOpen && daa > 0 && (
                <div className="text-xs text-keryx-warn">
                  Private inference activates at DAA {Number(gateDaa).toLocaleString("en-US")} (now {daa.toLocaleString("en-US")}).
                </div>
              )}
              {miners === 0 && (
                <div className="text-xs text-keryx-error">
                  No miner is serving {shortLabel(LINEUP[tier])} right now. Pick another model or try again in a moment.
                </div>
              )}
              {!hasFunds && <div className="text-xs text-keryx-error">Balance too low: a message costs {krx(cost)} KRX.</div>}
              {error && <div className="break-words text-xs text-keryx-error">{error}</div>}
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (canSend) send();
                    }
                  }}
                  rows={Math.min(8, Math.max(1, draft.split("\n").length))}
                  placeholder={`Message ${shortLabel(LINEUP[tier])}…`}
                  className="flex-1 resize-none rounded-sm border border-keryx-border bg-keryx-bg px-3 py-2.5 text-keryx-text placeholder:text-keryx-dim focus:outline-none"
                />
                <button onClick={() => send()} disabled={!canSend} className="btn-primary px-4 py-2.5" aria-label="Send">
                  {sending ? "…" : "↑"}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-keryx-dim">
                <span>Enter to send · Shift+Enter for a new line · each message is an on-chain transaction</span>
                <span>
                  web search:{" "}
                  {(["auto", "on", "off"] as WebMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setWebMode(mode);
                        saveWebMode(mode);
                      }}
                      className={`px-1 hover:underline ${webMode === mode ? "font-bold text-keryx-bright" : "text-keryx-dim"}`}
                      title={
                        mode === "auto"
                          ? "Searches the web when the question looks like it needs it (news, prices, dates, 'search: …'). The search query (not your message) goes in clear to the keryx-labs.com relay."
                          : mode === "on"
                            ? "Searches the web for every message."
                            : "Never searches the web."
                      }
                    >
                      {mode}
                    </button>
                  ))}
                  {searching ? <span className="animate-pulse"> searching…</span> : null}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
