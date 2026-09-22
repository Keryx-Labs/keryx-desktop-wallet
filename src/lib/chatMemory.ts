// Conversation memory for on-chain inference.
//
// The miner wraps the whole prompt in a single user turn of the model's chat
// template, so earlier exchanges travel as plain text inside that turn. Role
// tokens are model-specific and are never written here.

import { MAX_AI_REQUEST_PAYLOAD_LEN, MIN_AI_REQUEST_PAYLOAD_LEN } from "./aiRequest";

/** Largest prompt an AiRequest payload can carry. */
export const MAX_PROMPT_BYTES = MAX_AI_REQUEST_PAYLOAD_LEN - MIN_AI_REQUEST_PAYLOAD_LEN;

/** Below this many bytes left, a truncated answer carries too little to be worth sending. */
const MIN_TRUNCATED_ANSWER_BYTES = 160;

export interface Exchange {
  question: string;
  answer: string;
}

export interface ComposedPrompt {
  prompt: string;
  bytes: number;
  /** Exchanges included, most recent last. */
  used: number;
  /** Exchanges left out for lack of room. */
  dropped: number;
  /** The oldest included answer was cut to fit. */
  truncated: boolean;
}

const HEADER = "Conversation so far:\n\n";
const FOOTER = "Continue the conversation. The user's new message:\n";
const ELLIPSIS = " […]";

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function formatExchange(e: Exchange): string {
  return `User: ${e.question}\nAssistant: ${e.answer}\n\n`;
}

/** Longest prefix of `s` that fits in `maxBytes` of UTF-8, cut on a code point boundary. */
function truncateToBytes(s: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > maxBytes) break;
    used += n;
    out += ch;
  }
  return out;
}

/**
 * Prepend as many earlier exchanges as fit in `maxBytes`, most recent first. The new question is
 * always kept whole; with no usable history the prompt is the question unchanged.
 */
export function composePrompt(
  history: Exchange[],
  question: string,
  maxBytes: number = MAX_PROMPT_BYTES,
): ComposedPrompt {
  const bare: ComposedPrompt = {
    prompt: question,
    bytes: byteLength(question),
    used: 0,
    dropped: history.length,
    truncated: false,
  };
  if (history.length === 0) return bare;

  let budget = maxBytes - byteLength(HEADER) - byteLength(FOOTER) - byteLength(question);
  const kept: string[] = [];
  let truncated = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const block = formatExchange(history[i]);
    const n = byteLength(block);
    if (n <= budget) {
      kept.unshift(block);
      budget -= n;
      continue;
    }
    const skeleton = formatExchange({ question: history[i].question, answer: "" });
    const room = budget - byteLength(skeleton) - byteLength(ELLIPSIS);
    if (room >= MIN_TRUNCATED_ANSWER_BYTES) {
      const answer = truncateToBytes(history[i].answer, room) + ELLIPSIS;
      kept.unshift(formatExchange({ question: history[i].question, answer }));
      truncated = true;
    }
    break;
  }
  if (kept.length === 0) return bare;

  const prompt = HEADER + kept.join("") + FOOTER + question;
  return {
    prompt,
    bytes: byteLength(prompt),
    used: kept.length,
    dropped: history.length - kept.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Local persistence
// ---------------------------------------------------------------------------

const CONVERSATION_PREFIX = "keryx.chat.conversation.";
const MEMORY_KEY = "keryx.chat.memory";

export function conversationKey(networkId: string, walletAddress: string | null): string {
  return `${CONVERSATION_PREFIX}${networkId}.${walletAddress ?? "none"}`;
}

export function loadMemoryEnabled(): boolean {
  try {
    return localStorage.getItem(MEMORY_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveMemoryEnabled(on: boolean): void {
  try {
    localStorage.setItem(MEMORY_KEY, on ? "on" : "off");
  } catch {
    /* per-viewer convenience only */
  }
}

/** Load a stored conversation; bigint fields are stored as decimal strings. */
export function loadConversation<T>(key: string, revive: (raw: unknown) => T | null): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(revive).filter((m): m is T => m !== null);
  } catch {
    return [];
  }
}

export function saveConversation(key: string, messages: unknown[]): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify(messages, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  } catch {
    /* per-viewer convenience only */
  }
}
