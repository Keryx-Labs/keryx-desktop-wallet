import { useEffect, useRef, useState } from "react";
import { wallet, formatKrx } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import {
  MODELS,
  ModelName,
  computeInferenceReward,
  MIN_AI_REQUEST_PRIORITY_FEE,
} from "../lib/aiRequest";

// Token budgets offered in the UI. The reward scales with this (0.05 KRX / 64).
const TOKEN_PRESETS = [128, 256, 512] as const;
const DEFAULT_MODEL: ModelName = "qwen3-1.7b";
const DEFAULT_MAX_TOKENS = 256;

type ChatMessage =
  | { role: "user"; text: string; model: ModelName; totalSompi: bigint }
  | {
      role: "assistant";
      status: "pending" | "done" | "error";
      text: string | null;
      note?: string;
    };

const MODEL_ORDER: ModelName[] = [
  "qwen3-1.7b",
  "gemma-3-4b",
  "dolphin-llama3-8b",
  "qwen3-32b-abliterated",
  "llama-3.3-70b-q2",
];

export function Chat({ onClose }: { onClose: () => void }) {
  const w = useWalletState();

  const [model, setModel] = useState<ModelName>(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState<number>(DEFAULT_MAX_TOKENS);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // --- cost, computed from the same constants the node enforces ---
  const rewardSompi = computeInferenceReward(MODELS[model].baseRewardSompi, maxTokens);
  const feeSompi = MIN_AI_REQUEST_PRIORITY_FEE;
  const totalSompi = rewardSompi + feeSompi;

  const connected = w.conn === "connected" && w.synced;
  const hasFunds = w.balance.mature > totalSompi;
  const canSend =
    connected && hasFunds && !busy && prompt.trim().length > 0 && wallet.isOpen;

  async function send() {
    setErr(null);
    if (!canSend) return;
    const text = prompt.trim();
    setPrompt("");
    setMessages((m) => [
      ...m,
      { role: "user", text, model, totalSompi },
      { role: "assistant", status: "pending", text: null },
    ]);
    setBusy(true);
    try {
      const answer = await runInference({ prompt: text, model, maxTokens });
      setMessages((m) => replaceLastAssistant(m, { role: "assistant", status: "done", text: answer }));
    } catch (e) {
      setMessages((m) =>
        replaceLastAssistant(m, {
          role: "assistant",
          status: "error",
          text: null,
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
          ⚠️ <b>Public:</b> your prompt is written on-chain and the answer is
          stored on IPFS — anyone can read both. No private messaging yet.
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
        {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
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
            placeholder={
              connected ? "Type your prompt…" : "Connect to a node to ask…"
            }
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
            waiting for a miner…
          </p>
        )}
        {msg.status === "done" && (
          <p className="whitespace-pre-wrap text-sm text-emerald-100/90">{msg.text}</p>
        )}
        {msg.status === "error" && (
          <p className="text-sm text-red-300">{msg.note ?? "Request failed."}</p>
        )}
      </div>
    </div>
  );
}

function replaceLastAssistant(
  msgs: ChatMessage[],
  next: ChatMessage,
): ChatMessage[] {
  const out = [...msgs];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "assistant") {
      out[i] = next;
      break;
    }
  }
  return out;
}

// --- integration seam ---
// The on-chain flow (build AiRequest via lib/aiRequest → submit over wRPC →
// poll for the AiResponse → fetch the result from IPFS) lands here in the next
// step (lib/inferenceClient). Until then this reports that submission is not
// wired, rather than fabricating an answer.
async function runInference(_args: {
  prompt: string;
  model: ModelName;
  maxTokens: number;
}): Promise<string> {
  throw new Error("On-chain submission is not wired yet (data layer next).");
}
