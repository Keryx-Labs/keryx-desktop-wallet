/**
 * Conversations of the inference chat, kept in this browser only.
 *
 * The chain holds ciphertext, so the readable history lives here: encrypted at rest with a key
 * derived from the wallet key, unreadable while the wallet is locked. Root keys are never stored;
 * each one re-derives from the wallet key and the request's cohort seed.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "./privateInference";

export interface ChatMessage {
  /** AiRequest transaction id. */
  id: string;
  question: string;
  model: string;
  maxTokens: number;
  /** Reward plus fee, in sompi. */
  costSompi: number;
  sentAt: number;
  /** Cohort seed of the request (hex); its root key re-derives from it. */
  seedHex: string;
  recipients: number;
  /** Earlier exchanges sent along as context. */
  contextUsed: number;
  /** Bytes of Keryx facts sent along, when the question was about Keryx. */
  factsBytes?: number;
  /** Web search results sent along, in prompt order. */
  sources?: { title: string; url: string }[];
  status: "pending" | "answered" | "failed";
  answer?: string;
  responder?: string;
  answeredAt?: number;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const STORE_PREFIX = "keryx.chats.v1.";
const STORE_SALT = new TextEncoder().encode("KeryxChatStoreV1");
const STORE_INFO = new TextEncoder().encode("aes-256-gcm");

async function storeKey(privateKeyHex: string): Promise<CryptoKey> {
  const raw = hkdf(sha256, hexToBytes(privateKeyHex), STORE_SALT, STORE_INFO, 32);
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Conversations of `address`, newest first. Empty when nothing is stored or it does not open. */
export async function loadConversations(address: string, privateKeyHex: string): Promise<Conversation[]> {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + address);
    if (!raw) return [];
    const { iv, data } = JSON.parse(raw) as { iv: string; data: string };
    const key = await storeKey(privateKeyHex);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) as BufferSource }, key, fromBase64(data) as BufferSource);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
  } catch {
    return [];
  }
}

export async function saveConversations(address: string, privateKeyHex: string, conversations: Conversation[]): Promise<void> {
  const key = await storeKey(privateKeyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(conversations));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  // Chunked: a long history overflows the argument list of a single fromCharCode call.
  let b64 = "";
  for (let i = 0; i < data.length; i += 0x6000) b64 += toBase64(data.subarray(i, i + 0x6000));
  localStorage.setItem(STORE_PREFIX + address, JSON.stringify({ iv: toBase64(iv), data: b64 }));
}

// ── Context ───────────────────────────────────────────────────────────────────

const HEADER = "Conversation so far:\n\n";
const FOOTER = "Continue the conversation. The user's new message:\n";
const ELLIPSIS = " […]";
/** Below this many bytes left, a truncated answer carries too little to be worth sending. */
const MIN_TRUNCATED_ANSWER_BYTES = 160;

const encoder = new TextEncoder();
export const byteLength = (s: string) => encoder.encode(s).length;

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

function tailToBytes(s: string, maxBytes: number): string {
  const chars = Array.from(s);
  let used = 0;
  let from = chars.length;
  while (from > 0) {
    const n = byteLength(chars[from - 1]);
    if (used + n > maxBytes) break;
    used += n;
    from--;
  }
  return chars.slice(from).join("");
}

const formatExchange = (question: string, answer: string) => `User: ${question}\nAssistant: ${answer}\n\n`;

/**
 * Prepends as many earlier exchanges as fit in `maxBytes`, most recent first. The miner wraps
 * the whole prompt in a single user turn, so the history travels as plain text. The new question
 * is always kept whole; with no usable history the prompt is the question unchanged.
 * `continuing`: the question asks to resume the last answer, so when that answer does not fit
 * its end is kept rather than its beginning.
 */
export function composePrompt(
  history: { question: string; answer: string }[],
  question: string,
  maxBytes: number,
  continuing = false
): { prompt: string; used: number } {
  let budget = maxBytes - byteLength(HEADER) - byteLength(FOOTER) - byteLength(question);
  const kept: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const block = formatExchange(history[i].question, history[i].answer);
    const n = byteLength(block);
    if (n <= budget) {
      kept.unshift(block);
      budget -= n;
      continue;
    }
    const room = budget - byteLength(formatExchange(history[i].question, "")) - byteLength(ELLIPSIS);
    if (room >= MIN_TRUNCATED_ANSWER_BYTES) {
      const answer =
        continuing && i === history.length - 1
          ? ELLIPSIS.trimStart() + " " + tailToBytes(history[i].answer, room)
          : truncateToBytes(history[i].answer, room) + ELLIPSIS;
      kept.unshift(formatExchange(history[i].question, answer));
    }
    break;
  }
  if (kept.length === 0) return { prompt: question, used: 0 };
  return { prompt: HEADER + kept.join("") + FOOTER + question, used: kept.length };
}
