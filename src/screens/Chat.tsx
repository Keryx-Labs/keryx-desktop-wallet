import { useEffect, useRef, useState } from "react";
import { wallet, formatKrx } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import {
  MODELS,
  ModelName,
  computeInferenceReward,
  MIN_AI_REQUEST_PRIORITY_FEE,
  PRIVATE_MARKER_SOMPI,
  h14ActivationDaa,
  networkModelFor,
  type AiAvailability,
} from "../lib/aiRequest";
import { fetchAnswerText } from "../lib/aiResponse";
import {
  MAX_PROMPT_BYTES,
  composePrompt,
  conversationKey,
  loadConversation,
  loadMemoryEnabled,
  saveConversation,
  saveMemoryEnabled,
  type Exchange,
} from "../lib/chatMemory";
import { Select } from "../components/Select";

const TOKEN_PRESETS = [128, 256, 512] as const;
const DEFAULT_MODEL: ModelName = "qwen3.5-9b-abliterated";
const CAPS_POLL_MS = 30_000;
const DEFAULT_MAX_TOKENS = 256;

const LINEUP_H6: ModelName[] = [
  "qwen3.5-9b-abliterated",
  "glm-4-9b-0414",
  "gemma-4-12b-abliterated",
  "qwen3.6-27b",
  "kimi-linear-48b",
];

type Visibility = "public" | "private";
const VISIBILITY_KEY = "keryx.chat.visibility";
function loadVisibility(): Visibility {
  try {
    return localStorage.getItem(VISIBILITY_KEY) === "private" ? "private" : "public";
  } catch {
    return "public";
  }
}

type ChatMessage =
  | {
      role: "user";
      text: string;
      model: ModelName;
      totalSompi: bigint;
      isPrivate: boolean;
      /** Earlier exchanges sent along with this message. */
      context?: number;
    }
  | {
      role: "assistant";
      status: "pending" | "submitted" | "answered" | "error";
      txId: string | null;
      note?: string;
      reqHash?: string;
      cursor?: string;
      cidUrl?: string;
      cidV0?: string;
      answerText?: string;
      answerError?: boolean;
      attempts?: number;
    };

// ~6s poll interval × MAX_POLLS ≈ 5 min before we stop watching for the answer.
const POLL_MS = 6000;
const MAX_POLLS = 50;

function exchangesOf(msgs: ChatMessage[]): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i + 1 < msgs.length; i++) {
    const q = msgs[i];
    const a = msgs[i + 1];
    if (q.role === "user" && a.role === "assistant" && a.status === "answered" && a.answerText) {
      out.push({ question: q.text, answer: a.answerText.trim() });
    }
  }
  return out;
}

function reviveMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.role === "user" && typeof m.text === "string" && typeof m.model === "string") {
    return {
      role: "user",
      text: m.text,
      model: m.model as ModelName,
      totalSompi: BigInt(typeof m.totalSompi === "string" ? m.totalSompi : 0),
      isPrivate: m.isPrivate === true,
      context: typeof m.context === "number" ? m.context : undefined,
    };
  }
  if (m.role === "assistant" && typeof m.status === "string") {
    const a = m as unknown as Extract<ChatMessage, { role: "assistant" }>;
    if (a.status === "pending") {
      return {
        role: "assistant",
        status: "error",
        txId: null,
        note: "Interrupted while sending. Check your transaction history before asking again.",
      };
    }
    // A reopened chat resumes watching from the stored cursor.
    return a.status === "submitted" ? { ...a, attempts: 0 } : a;
  }
  return null;
}

function formatKb(bytes: number): string {
  return (bytes / 1000).toFixed(1);
}

export function Chat({ onClose }: { onClose: () => void }) {
  const w = useWalletState();

  const [model, setModel] = useState<ModelName>(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState<number>(DEFAULT_MAX_TOKENS);
  const [visibility, setVisibility] = useState<Visibility>(loadVisibility);
  useEffect(() => {
    try {
      localStorage.setItem(VISIBILITY_KEY, visibility);
    } catch {
      /* per-viewer convenience only */
    }
  }, [visibility]);
  const isPrivate = visibility === "private";
  const [memoryOn, setMemoryOn] = useState<boolean>(loadMemoryEnabled);
  useEffect(() => saveMemoryEnabled(memoryOn), [memoryOn]);
  const [prompt, setPrompt] = useState("");
  const convKey = conversationKey(w.networkId, w.receiveAddresses[0] ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadConversation(convKey, reviveMessage),
  );
  const loadedKey = useRef(convKey);
  useEffect(() => {
    if (loadedKey.current === convKey) return;
    loadedKey.current = convKey;
    setMessages(loadConversation(convKey, reviveMessage));
  }, [convKey]);
  useEffect(() => {
    saveConversation(loadedKey.current, messages);
  }, [messages]);
  const [busy, setBusy] = useState(false);
  // Active miners per model_id hex (explorer API, last 20 min); null until the first answer.
  const [caps, setCaps] = useState<Map<string, number> | null>(null);
  // Network-model availability (H14, explorer API); null until the first answer.
  const [availability, setAvailability] = useState<AiAvailability | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void wallet.fetchCapabilities().then((c) => alive && c && setCaps(c));
      void wallet.fetchAiAvailability().then((a) => alive && a && setAvailability(a));
    };
    load();
    const id = setInterval(load, CAPS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [w.networkId]);
  // Past H14 the lineup is paused: the network model is the only servable target.
  const networkModel = networkModelFor(w.networkId);
  const h14Active = w.nodeDaa != null && BigInt(w.nodeDaa) >= h14ActivationDaa(w.networkId);
  const modelOrder: ModelName[] = h14Active ? [networkModel] : LINEUP_H6;
  useEffect(() => {
    if (!modelOrder.includes(model)) setModel(modelOrder[0]);
  }, [h14Active]);
  const networkModelSelected = h14Active && model === networkModel;
  const missingShard = availability?.shards.find((s) => s.producers === 0) ?? null;
  const minersFor = (k: ModelName) => caps?.get(MODELS[k].modelIdHex) ?? 0;
  // Network model: the thinnest shard decides.
  const activeMiners = networkModelSelected
    ? availability
      ? availability.shards.length > 0
        ? Math.min(...availability.shards.map((s) => s.producers))
        : 0
      : null
    : caps
      ? minersFor(model)
      : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Poll the chain for each submitted request's on-chain answer (wRPC). Reads the
  // latest messages via a ref so the interval isn't torn down on every update.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    const id = setInterval(async () => {
      const snapshot = messagesRef.current;
      for (let i = 0; i < snapshot.length; i++) {
        const m = snapshot[i];
        if (m.role !== "assistant" || m.status !== "submitted" || !m.reqHash) continue;
        if ((m.attempts ?? 0) >= MAX_POLLS) continue;
        try {
          const { result, cursorHash } = await wallet.pollInferenceResult(
            m.reqHash,
            m.cursor ?? "",
          );
          if (result) {
            const rh = m.reqHash;
            setMessages((cur) =>
              cur.map((x) =>
                x.role === "assistant" && x.reqHash === rh
                  ? { ...x, status: "answered", cidUrl: result.url, cidV0: result.cidV0 }
                  : x,
              ),
            );
            // Fetch + render the answer inline (escaped text) from our IPFS gateway.
            fetchAnswerText(result.cidV0, wallet.ipfsGateway)
              .then((text) =>
                setMessages((cur) =>
                  cur.map((x) =>
                    x.role === "assistant" && x.reqHash === rh ? { ...x, answerText: text } : x,
                  ),
                ),
              )
              .catch(() =>
                setMessages((cur) =>
                  cur.map((x) =>
                    x.role === "assistant" && x.reqHash === rh ? { ...x, answerError: true } : x,
                  ),
                ),
              );
          } else {
            setMessages((cur) =>
              cur.map((x, j) =>
                j === i && x.role === "assistant"
                  ? { ...x, cursor: cursorHash, attempts: (x.attempts ?? 0) + 1 }
                  : x,
              ),
            );
          }
        } catch {
          /* transient RPC error — retry next tick */
        }
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Cost = reward (vault → responder) + fee (burned). Computed from the node-enforced
  // minimums.
  const rewardSompi = computeInferenceReward(MODELS[model].baseRewardSompi, maxTokens);
  const feeSompi = MIN_AI_REQUEST_PRIORITY_FEE;
  const totalSompi = rewardSompi + feeSompi;

  const history = memoryOn ? exchangesOf(messages) : [];
  const preview = composePrompt(history, prompt.trim());
  const tooLong = preview.bytes > MAX_PROMPT_BYTES;

  const connected = w.conn === "connected" && w.synced;
  // The private marker is a self-send, so it must be funded even though it comes back.
  const hasFunds = w.balance.mature > totalSompi + (isPrivate ? PRIVATE_MARKER_SOMPI : 0n);
  const canSend =
    connected &&
    hasFunds &&
    !busy &&
    wallet.isOpen &&
    prompt.trim().length > 0 &&
    !tooLong &&
    // devnet has no explorer API, so availability stays unknown there; the node's mempool
    // still refuses a request no shard tier can serve.
    (!networkModelSelected || availability?.available === true || w.networkId === "devnet");

  async function send() {
    if (!canSend) return;
    const text = prompt.trim();
    const composed = composePrompt(memoryOn ? exchangesOf(messages) : [], text);
    const model_ = model;
    const maxTokens_ = maxTokens;
    const isPrivate_ = isPrivate;
    const cost = totalSompi;
    setPrompt("");
    setMessages((m) => [
      ...m,
      {
        role: "user",
        text,
        model: model_,
        totalSompi: cost,
        isPrivate: isPrivate_,
        context: composed.used,
      },
      { role: "assistant", status: "pending", txId: null },
    ]);
    setBusy(true);
    try {
      // 1) check that the model can be served: every shard has a miner (network model), or a
      //    miner advertises the model in its coinbase (lineup)
      if (networkModelSelected && w.networkId !== "devnet") {
        const a = await wallet.fetchAiAvailability();
        if (!a) throw new Error("Could not check the shard miners. Try again in a moment.");
        if (!a.available) {
          const missing = a.shards.find((s) => s.producers === 0);
          throw new Error(
            `The network model cannot be assembled: no miner holds shard tier ${missing?.tier ?? "?"}. Try again later.`,
          );
        }
      } else if (!networkModelSelected) {
        const providers = await wallet.fetchModelEscrowPubkeys(MODELS[model_].modelIdHex);
        if (providers.length === 0) {
          throw new Error(
            "No miner is currently serving this model. Try another model.",
          );
        }
      }
      // 2) build + sign + submit the AiRequest
      const { txId, requestHashHex, cursorHash } = await wallet.submitInference({
        model: model_,
        prompt: composed.prompt,
        maxTokens: maxTokens_,
        isPrivate: isPrivate_,
      });
      setMessages((m) =>
        replaceLastAssistant(m, {
          role: "assistant",
          status: "submitted",
          txId,
          reqHash: requestHashHex,
          cursor: cursorHash,
          attempts: 0,
        }),
      );
    } catch (e) {
      setMessages((m) =>
        replaceLastAssistant(m, {
          role: "assistant",
          status: "error",
          txId: null,
          note: e instanceof Error ? e.message : "Request failed.",
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-keryx-bg">
      {/* header */}
      <header className="flex items-center justify-between border-b border-keryx-border px-5 py-3">
        <div>
          <h2 className="text-lg font-bold text-keryx-green">Inference</h2>
          <p className="text-xs text-emerald-200/50">Ask the Keryx network</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            onClick={() => setMessages([])}
            disabled={busy || messages.length === 0}
            title="Start over: earlier messages are no longer sent along."
          >
            New conversation
          </button>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {/* controls: model + token budget */}
      <div className="flex flex-wrap items-end gap-3 border-b border-keryx-border px-5 py-3">
        <label className="min-w-[12rem] flex-1">
          <span className="label text-keryx-green">Model</span>
          <Select
            value={model}
            onChange={setModel}
            disabled={busy}
            options={modelOrder.map((k) => ({
              value: k,
              label:
                MODELS[k].label +
                (h14Active && k === networkModel
                  ? availability
                    ? ` · ${availability.available ? "available" : "unavailable"}`
                    : ""
                  : caps
                    ? ` · ${minersFor(k)} miner${minersFor(k) === 1 ? "" : "s"}`
                    : ""),
            }))}
          />
        </label>
        <label>
          <span className="label text-keryx-green">Max tokens</span>
          <Select
            value={String(maxTokens)}
            onChange={(v) => setMaxTokens(Number(v))}
            disabled={busy}
            options={TOKEN_PRESETS.map((t) => ({ value: String(t), label: String(t) }))}
          />
        </label>
        <label
          title="Private keeps the request off the public inference feed on the explorer. It is not encryption: prompt and answer stay readable on-chain. Costs nothing extra (a 0.5 KRX self-send that comes back to you)."
        >
          <span className="label text-keryx-green">Visibility</span>
          <Select
            value={visibility}
            onChange={setVisibility}
            disabled={busy}
            options={[
              { value: "public", label: "Public feed" },
              { value: "private", label: "Private" },
            ]}
          />
        </label>
        <label
          title="Memory sends your earlier exchanges along with each new message, so the model can build on them. They go on-chain inside the prompt, like the message itself. Costs nothing extra; up to 4 KB per request, the most recent exchanges first."
        >
          <span className="label text-keryx-green">Memory</span>
          <Select
            value={memoryOn ? "on" : "off"}
            onChange={(v) => setMemoryOn(v === "on")}
            disabled={busy}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </label>
      </div>

      {activeMiners !== null && !networkModelSelected && (
        <div
          className={`border-b border-keryx-border px-5 py-2 font-mono text-[11px] ${
            activeMiners > 0 ? "text-keryx-green" : "text-keryx-error"
          }`}
        >
          {activeMiners > 0
            ? `${activeMiners} active miner${activeMiners > 1 ? "s" : ""} for this model`
            : `⚠ No active miners for ${MODELS[model].label} in the last 20 minutes.`}
        </div>
      )}
      {networkModelSelected && availability && (
        <div
          className={`flex flex-wrap gap-x-3 gap-y-1 border-b border-keryx-border px-5 py-2 font-mono text-[11px] ${
            availability.available ? "text-keryx-green" : "text-keryx-error"
          }`}
        >
          <span>
            {availability.available
              ? `${availability.shards.length} shards, one miner each per request`
              : `⚠ No miner holds shard tier ${missingShard?.tier ?? "?"} — the model cannot be assembled.`}
          </span>
          {availability.shards.map((s) => (
            <span key={s.tier} className={s.producers > 0 ? "text-keryx-dim" : "text-keryx-error"}>
              tier {s.tier} · {s.vramGb} GB · {s.producers} miner{s.producers === 1 ? "" : "s"}
            </span>
          ))}
        </div>
      )}

      {/* messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto px-5 py-4">
        {messages.length === 0 ? (
          <p className="mt-10 text-center text-sm text-emerald-200/30">
            Pick a model and ask a question. Each request is a paid, on-chain
            transaction fulfilled by a miner.
          </p>
        ) : (
          messages.map((m, i) => <Bubble key={i} msg={m} />)
        )}
      </div>

      {/* composer */}
      <div className="border-t border-keryx-border px-5 py-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-emerald-200/50">
          <span>
            Cost:{" "}
            <span className="font-mono text-keryx-green">
              {formatKrx(totalSompi)} KRX
            </span>{" "}
            <span className="text-emerald-200/30">
              ({formatKrx(rewardSompi)} reward + {formatKrx(feeSompi)} fee)
            </span>
          </span>
          <span className="font-mono text-emerald-200/40">
            balance {formatKrx(w.balance.mature)} KRX
          </span>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            className="input min-h-[3rem] flex-1 resize-none"
            rows={2}
            placeholder={connected ? "Type your prompt…" : "Connect to a node to ask…"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy || !connected}
          />
          <button className="btn-primary px-5" onClick={() => void send()} disabled={!canSend}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
        {memoryOn && history.length > 0 && !tooLong && (
          <p className="mt-2 font-mono text-[11px] text-emerald-200/40">
            context: {preview.used} of {history.length} earlier exchange
            {history.length === 1 ? "" : "s"}
            {preview.truncated ? " (oldest cut)" : ""} · {formatKb(preview.bytes)} /{" "}
            {formatKb(MAX_PROMPT_BYTES)} KB
          </p>
        )}
        {tooLong && (
          <p className="mt-2 text-xs text-amber-300/80">
            Message too long: {formatKb(preview.bytes)} / {formatKb(MAX_PROMPT_BYTES)} KB.
          </p>
        )}
        {!connected && (
          <p className="mt-2 text-xs text-amber-300/80">
            Not connected / synced — requests are disabled.
          </p>
        )}
        {connected && !hasFunds && (
          <p className="mt-2 text-xs text-amber-300/80">
            Insufficient balance for this request.
          </p>
        )}
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-keryx-green/30 bg-keryx-green/10 px-4 py-2">
          <p className="whitespace-pre-wrap text-sm text-emerald-50">{msg.text}</p>
          <p className="mt-1 text-right text-[10px] text-emerald-200/40">
            {MODELS[msg.model]?.label ?? msg.model} · {formatKrx(msg.totalSompi)} KRX
            {msg.isPrivate ? " · private" : ""}
            {msg.context ? ` · + ${msg.context} earlier exchange${msg.context === 1 ? "" : "s"}` : ""}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm border border-keryx-border bg-black/30 px-4 py-2">
        {msg.status === "pending" && (
          <p className="animate-pulse text-sm text-emerald-200/50">
            finding a miner &amp; submitting…
          </p>
        )}
        {msg.status === "submitted" && (
          <div className="text-sm text-emerald-100/90">
            <p className="animate-pulse text-emerald-200/60">
              Submitted ✓ — waiting for the miner's answer…
            </p>
            {msg.txId && (
              <p className="mt-1 font-mono text-[10px] text-emerald-200/40">
                tx {msg.txId.slice(0, 10)}…{msg.txId.slice(-6)}
              </p>
            )}
            {(msg.attempts ?? 0) >= MAX_POLLS && (
              <p className="mt-1 text-[11px] text-amber-300/70">
                Still no answer after a few minutes — the miner may be slow or
                offline. The request stays valid on-chain.
              </p>
            )}
          </div>
        )}
        {msg.status === "answered" && (
          <div className="text-sm text-emerald-100/90">
            {msg.answerText !== undefined ? (
              <p className="whitespace-pre-wrap">{msg.answerText}</p>
            ) : msg.answerError ? (
              <p className="text-amber-300/80">
                Answer ready ✓ — couldn't load it inline, open it on IPFS below.
              </p>
            ) : (
              <p className="animate-pulse text-emerald-200/60">
                Answer ready ✓ — loading…
              </p>
            )}
            {msg.cidUrl && (
              <a
                href={msg.cidUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[11px] text-keryx-green/80 underline hover:text-emerald-300"
              >
                View on IPFS ↗
              </a>
            )}
          </div>
        )}
        {msg.status === "error" && (
          <p className="text-sm text-red-300">{msg.note ?? "Request failed."}</p>
        )}
      </div>
    </div>
  );
}

function replaceLastAssistant(msgs: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const out = [...msgs];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "assistant") {
      out[i] = next;
      break;
    }
  }
  return out;
}
