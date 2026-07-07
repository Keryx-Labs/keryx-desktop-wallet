import { useEffect, useRef, useState } from "react";
import { wallet, formatKrx } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import {
  MODELS,
  ModelName,
  computeInferenceReward,
  MIN_AI_REQUEST_PRIORITY_FEE,
} from "../lib/aiRequest";
import { fetchAnswerText } from "../lib/aiResponse";

const TOKEN_PRESETS = [128, 256, 512] as const;
const DEFAULT_MODEL: ModelName = "qwen3-1.7b";
const DEFAULT_MAX_TOKENS = 256;

const MODEL_ORDER: ModelName[] = [
  "qwen3-1.7b",
  "gemma-3-4b",
  "dolphin-llama3-8b",
  "qwen3-32b-abliterated",
  "llama-3.3-70b-q2",
];

type ChatMessage =
  | { role: "user"; text: string; model: ModelName; totalSompi: bigint }
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

export function Chat({ onClose }: { onClose: () => void }) {
  const w = useWalletState();

  const [model, setModel] = useState<ModelName>(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState<number>(DEFAULT_MAX_TOKENS);
  const [prompt, setPrompt] = useState("");
  const [password, setPassword] = useState(""); // kept for this chat session only
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);

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
            fetchAnswerText(result.cidV0)
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

  // Cost = reward (escrow → miner) + fee (burned). Computed from the node-enforced
  // minimums. The private-marker output is a self-send, so it is NOT a cost.
  const rewardSompi = computeInferenceReward(MODELS[model].baseRewardSompi, maxTokens);
  const feeSompi = MIN_AI_REQUEST_PRIORITY_FEE;
  const totalSompi = rewardSompi + feeSompi;

  const connected = w.conn === "connected" && w.synced;
  const hasFunds = w.balance.mature > totalSompi;
  const canSend =
    connected &&
    hasFunds &&
    !busy &&
    wallet.isOpen &&
    prompt.trim().length > 0 &&
    password.length > 0;

  async function send() {
    if (!canSend) return;
    const text = prompt.trim();
    const pw = password;
    const model_ = model;
    const maxTokens_ = maxTokens;
    const cost = totalSompi;
    setPrompt("");
    setMessages((m) => [
      ...m,
      { role: "user", text, model: model_, totalSompi: cost },
      { role: "assistant", status: "pending", txId: null },
    ]);
    setBusy(true);
    try {
      // 1) find an active miner serving this model (wRPC coinbase scan)
      const escrows = await wallet.fetchModelEscrowPubkeys(MODELS[model_].modelIdHex);
      if (escrows.length === 0) {
        throw new Error(
          "No miner is currently serving this model. Try another model.",
        );
      }
      // 2) build + sign + submit the (private) AiRequest
      const { txId, requestHashHex, cursorHash } = await wallet.submitInference(pw, {
        model: model_,
        prompt: text,
        maxTokens: maxTokens_,
        minerEscrowPubkeyHex: escrows[0],
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
    <div className="fixed inset-0 z-40 flex flex-col bg-keryx-dark">
      {/* header */}
      <header className="flex items-center justify-between border-b border-keryx-border px-5 py-3">
        <div>
          <h2 className="text-lg font-bold text-keryx-green">Inference</h2>
          <p className="text-xs text-emerald-200/50">Ask the Keryx network</p>
        </div>
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
          Close
        </button>
      </header>

      {/* controls: model + token budget */}
      <div className="flex flex-wrap items-end gap-3 border-b border-keryx-border px-5 py-3">
        <label className="min-w-[12rem] flex-1">
          <span className="label">Model</span>
          <select
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value as ModelName)}
            disabled={busy}
          >
            {MODEL_ORDER.map((k) => (
              <option key={k} value={k}>
                {MODELS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Max tokens</span>
          <select
            className="input"
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            disabled={busy}
          >
            {TOKEN_PRESETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* guardrails */}
      <div className="space-y-1 border-b border-keryx-border bg-black/20 px-5 py-2 text-[11px] leading-snug text-emerald-200/50">
        <p>
          ⚠️ <b>On-chain &amp; readable:</b> your prompt is written on-chain and the
          answer is stored on IPFS. Your wallet marks these to stay off the public
          inference feed, but they are not encrypted — not private messaging.
        </p>
        <p>
          ⚠️ <b>Optimistic:</b> answers are served under a challenge window, not
          cryptographically verified. Don't rely on them as ground truth.
        </p>
      </div>

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
        <input
          type="password"
          className="input mb-2"
          placeholder="Wallet password (to sign the request)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          autoComplete="off"
        />
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
            {MODELS[msg.model].label} · {formatKrx(msg.totalSompi)} KRX
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
