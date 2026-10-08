/**
 * Private inference — client side of the end-to-end encrypted AiRequest / AiResponse.
 *
 * Byte-for-byte mirror of keryx-node `inference/src/private.rs` (envelopes, key schedule) and
 * `consensus/core/src/collateral.rs` (target cohort). A request is sealed to the escrow keys of
 * the whole tier cohort; the answer comes back sealed to the requester's root key.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// ── Wire constants (must match keryx-node) ────────────────────────────────────

const PRIVATE_MAGIC = new Uint8Array([0x00, 0x4b, 0x58, 0x50]); // 00 'K' 'X' 'P'
const PRIVATE_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const ROOT_KEY_LEN = 32;
const RECIPIENT_ENTRY_LEN = 32 + ROOT_KEY_LEN + TAG_LEN;
const REQUEST_ENVELOPE_HEADER_LEN = PRIVATE_MAGIC.length + 1 + 33 + NONCE_LEN + 1;
const RESPONSE_ENVELOPE_HEADER_LEN = PRIVATE_MAGIC.length + 1 + NONCE_LEN;

export const AI_REQUEST_HEADER_LEN = 52;
export const MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN = 65_536;
export const MAX_PRIVATE_RECIPIENTS = 128;
/** Providers beyond the current cohort a request is also sealed to (~30 min at 10 BPS). */
export const SEAL_WINDOW_DAA = 18_000;

const AI_RESPONSE_V1_LEN = 78;
const AI_RESPONSE_V2_LEN = 174;
const AI_RESPONSE_EXT_PRIVATE_BODY = 0x80;
const AI_RESPONSE_EXT_HEADER_LEN = 5;

const utf8 = (s: string) => new TextEncoder().encode(s);
const KDF_SALT = utf8("KeryxPrivateInferenceV1");
const INFO_KEK = utf8("kek");
const INFO_PROMPT = utf8("prompt");
const INFO_RESPONSE = utf8("response");
const COHORT_RANK_DOMAIN = utf8("KeryxPrivateCohortV1");
const ROOT_KEY_SALT = utf8("KeryxChatRootKeyV1");
const ROOT_KEY_INFO = utf8("root");

// ── Byte helpers ──────────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function u64(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} is not a valid u64`);
  return BigInt(value);
}

function hkdf32(salt: Uint8Array, ikm: Uint8Array, ...info: Uint8Array[]): Uint8Array {
  return hkdf(sha256, ikm, salt, concat(...info), 32);
}

// ── Request header ────────────────────────────────────────────────────────────

/** The 52-byte public AiRequest header: model_id ‖ max_tokens ‖ inference_reward ‖ priority_fee. */
export function requestHeaderBytes(
  modelIdHex: string,
  maxTokens: number,
  inferenceRewardSompi: number,
  priorityFeeSompi: number
): Uint8Array {
  const modelId = hexToBytes(modelIdHex);
  if (modelId.length !== 32) throw new Error("model id must be 32 bytes");
  if (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 0xffff_ffff) throw new Error("max_tokens out of u32 range");
  const out = new Uint8Array(AI_REQUEST_HEADER_LEN);
  const view = new DataView(out.buffer);
  out.set(modelId, 0);
  view.setUint32(32, maxTokens, true);
  view.setBigUint64(36, u64(inferenceRewardSompi, "inference reward"), true);
  view.setBigUint64(44, u64(priorityFeeSompi, "priority fee"), true);
  return out;
}

/** Largest plaintext prompt a request sealed to `nRecipients` keys can carry in `payloadLen` bytes. */
export function maxPrivatePromptLen(nRecipients: number, payloadLen = MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN): number {
  return Math.max(
    0,
    Math.min(payloadLen, MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN) -
      AI_REQUEST_HEADER_LEN -
      (REQUEST_ENVELOPE_HEADER_LEN + nRecipients * RECIPIENT_ENTRY_LEN + TAG_LEN)
  );
}

// Node relay limits for an AiRequest (mining/src/mempool/check_transaction_standard.rs): transient
// mass is 4 per serialized byte; compute mass is 1 per byte, 10 per output script byte, 1,000 per sig op.
const STANDARD_AI_REQUEST_TRANSIENT_MASS = (MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN + 4_096) * 4;
const STANDARD_COMPUTE_MASS = 100_000;
// Serialized-size upper bounds of a request without its payload (Schnorr P2PK inputs).
const TX_BASE_BYTES = 120;
const TX_INPUT_BYTES = 130;
const TX_OUTPUT_BYTES = 60;
const TX_OUTPUT_SCRIPT_MASS = 40 * 10;
const TX_OUTPUTS = 3;

/** Largest payload a request spending `inputCount` inputs keeps under the node's standard masses. */
export function maxRequestPayloadLen(inputCount: number): number {
  const rest = TX_BASE_BYTES + inputCount * TX_INPUT_BYTES + TX_OUTPUTS * TX_OUTPUT_BYTES;
  const byTransient = Math.floor(STANDARD_AI_REQUEST_TRANSIENT_MASS / 4) - rest;
  const byCompute = STANDARD_COMPUTE_MASS - rest - inputCount * 1_000 - TX_OUTPUTS * TX_OUTPUT_SCRIPT_MASS;
  return Math.max(0, Math.min(MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN, byTransient, byCompute));
}

/** Leading bytes of a prompt compressed with raw DEFLATE; the miner inflates it after opening. */
const COMPRESSED_PROMPT_MAGIC = new Uint8Array([0x00, 0x4b, 0x5a, 0x01]); // 00 'K' 'Z' 01

/** `text` as raw DEFLATE behind the compression magic. */
export async function compressPrompt(text: string): Promise<Uint8Array> {
  const stream = new Blob([utf8(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return concat(COMPRESSED_PROMPT_MAGIC, new Uint8Array(await new Response(stream).arrayBuffer()));
}

// ── Target cohort ─────────────────────────────────────────────────────────────

/** Cohort seed of a request: the outpoint its first input spends (`txid ‖ index u32 LE`). */
export function cohortSeed(transactionIdHex: string, index: number): Uint8Array {
  const txid = hexToBytes(transactionIdHex);
  if (txid.length !== 32) throw new Error("transaction id must be 32 bytes");
  const seed = new Uint8Array(36);
  seed.set(txid, 0);
  new DataView(seed.buffer).setUint32(32, index, true);
  return seed;
}

function cohortRank(seed: Uint8Array, key: Uint8Array): Uint8Array {
  return blake2b(concat(COHORT_RANK_DOMAIN, seed, key), { dkLen: 32 });
}

function sortedUniqueKeys(keysHex: string[]): Uint8Array[] {
  const unique = Array.from(new Set(keysHex.map((k) => k.toLowerCase()))).map(hexToBytes);
  for (const k of unique) if (k.length !== 32) throw new Error("escrow key must be 32 bytes");
  return unique.sort(compareBytes);
}

function byRank(seed: Uint8Array, keys: Uint8Array[]): Uint8Array[] {
  return keys
    .map((key) => ({ key, rank: cohortRank(seed, key) }))
    .sort((a, b) => compareBytes(a.rank, b.rank) || compareBytes(a.key, b.key))
    .map((e) => e.key);
}

/**
 * The escrow keys a request must be sealed to: the target cohort of its tier (the whole cohort up
 * to 128 keys, else the 128 of lowest rank), completed by rank with recently active providers.
 * `cohortHex` is the current cohort, `windowHex` the providers of the last `SEAL_WINDOW_DAA`.
 */
export function sealRecipients(seed: Uint8Array, cohortHex: string[], windowHex: string[] = []): string[] {
  let target = sortedUniqueKeys(cohortHex);
  if (target.length > MAX_PRIVATE_RECIPIENTS) {
    target = byRank(seed, target).slice(0, MAX_PRIVATE_RECIPIENTS);
  }
  const chosen = new Set(target.map(bytesToHex));
  const extra = byRank(
    seed,
    sortedUniqueKeys(windowHex).filter((k) => !chosen.has(bytesToHex(k)))
  ).slice(0, MAX_PRIVATE_RECIPIENTS - target.length);
  return [...target, ...extra].sort(compareBytes).map(bytesToHex);
}

// ── Root key ──────────────────────────────────────────────────────────────────

/**
 * Root key of a request, derived from the wallet key and the cohort seed (the first input's
 * outpoint, spent once). Re-derivable later from the seed phrase and the on-chain request alone.
 */
export function deriveRootKey(privateKeyHex: string, seed: Uint8Array): Uint8Array {
  return hkdf32(ROOT_KEY_SALT, hexToBytes(privateKeyHex), ROOT_KEY_INFO, seed);
}

// ── Seal / open ───────────────────────────────────────────────────────────────

export interface SealRequestArgs {
  modelIdHex: string;
  maxTokens: number;
  inferenceRewardSompi: number;
  priorityFeeSompi: number;
  /** Text, or bytes already encoded (see `compressPrompt`). */
  prompt: string | Uint8Array;
  /** Escrow keys to seal to (hex, any order, duplicates ignored). */
  recipientsHex: string[];
  rootKey: Uint8Array;
}

/** Builds the payload of a private AiRequest: public header ‖ sealed envelope. Returns hex. */
export function sealRequest(args: SealRequestArgs): string {
  const keys = sortedUniqueKeys(args.recipientsHex);
  if (keys.length === 0) throw new Error("no recipients: no miner of this tier is eligible right now");
  if (keys.length > MAX_PRIVATE_RECIPIENTS) throw new Error(`too many recipients: ${keys.length}`);
  if (args.rootKey.length !== ROOT_KEY_LEN) throw new Error("root key must be 32 bytes");
  const prompt = typeof args.prompt === "string" ? utf8(args.prompt) : args.prompt;
  const maxPrompt = maxPrivatePromptLen(keys.length);
  if (prompt.length > maxPrompt) {
    throw new Error(`prompt of ${prompt.length} bytes does not fit (maximum ${maxPrompt} for ${keys.length} recipients)`);
  }

  const header = requestHeaderBytes(args.modelIdHex, args.maxTokens, args.inferenceRewardSompi, args.priorityFeeSompi);
  const nonce = randomBytes(NONCE_LEN);
  const ephemeralSecret = secp256k1.utils.randomSecretKey();
  const ephemeralPubkey = secp256k1.getPublicKey(ephemeralSecret, true);

  const entries = keys.map((key) => {
    // BIP-340 even-Y lift of the x-only escrow key; libsecp ECDH = SHA-256(compressed shared point).
    const shared = sha256(secp256k1.getSharedSecret(ephemeralSecret, concat(new Uint8Array([0x02]), key), true));
    const kek = hkdf32(KDF_SALT, shared, INFO_KEK, ephemeralPubkey, key);
    return concat(key, chacha20poly1305(kek, nonce, header).encrypt(args.rootKey));
  });
  const envelopeHeader = concat(
    PRIVATE_MAGIC,
    new Uint8Array([PRIVATE_VERSION]),
    ephemeralPubkey,
    nonce,
    new Uint8Array([keys.length]),
    ...entries
  );
  const promptKey = hkdf32(KDF_SALT, args.rootKey, INFO_PROMPT);
  const ciphertext = chacha20poly1305(promptKey, nonce, concat(header, envelopeHeader)).encrypt(prompt);
  return bytesToHex(concat(header, envelopeHeader, ciphertext));
}

/** Requester side: reads back the prompt of one of its own sealed requests from its payload. */
export function openOwnPrompt(rootKey: Uint8Array, payload: Uint8Array): string {
  const prompt = payload.subarray(AI_REQUEST_HEADER_LEN);
  if (prompt.length < REQUEST_ENVELOPE_HEADER_LEN || compareBytes(prompt.subarray(0, 4), PRIVATE_MAGIC) !== 0) {
    throw new Error("not a private-inference envelope");
  }
  if (prompt[4] !== PRIVATE_VERSION) throw new Error("unsupported envelope version");
  const nonce = prompt.subarray(38, 50);
  const headerLen = REQUEST_ENVELOPE_HEADER_LEN + prompt[50] * RECIPIENT_ENTRY_LEN;
  if (prompt.length < headerLen + TAG_LEN) throw new Error("truncated envelope");
  const aad = concat(payload.subarray(0, AI_REQUEST_HEADER_LEN), prompt.subarray(0, headerLen));
  const promptKey = hkdf32(KDF_SALT, rootKey, INFO_PROMPT);
  return new TextDecoder().decode(chacha20poly1305(promptKey, nonce, aad).decrypt(prompt.subarray(headerLen)));
}

/** Requester side: opens an answer body sealed by `responderEscrowHex` for `requestIdHex`. */
export function openResponse(rootKey: Uint8Array, requestIdHex: string, responderEscrowHex: string, body: Uint8Array): string {
  if (body.length < RESPONSE_ENVELOPE_HEADER_LEN + TAG_LEN || compareBytes(body.subarray(0, 4), PRIVATE_MAGIC) !== 0) {
    throw new Error("not a private-inference envelope");
  }
  if (body[4] !== PRIVATE_VERSION) throw new Error("unsupported envelope version");
  const responder = hexToBytes(responderEscrowHex);
  const nonce = body.subarray(5, RESPONSE_ENVELOPE_HEADER_LEN);
  const key = hkdf32(KDF_SALT, rootKey, INFO_RESPONSE, responder);
  const aad = concat(hexToBytes(requestIdHex), responder);
  return new TextDecoder().decode(chacha20poly1305(key, nonce, aad).decrypt(body.subarray(RESPONSE_ENVELOPE_HEADER_LEN)));
}

// ── AiResponse payload ────────────────────────────────────────────────────────

export interface ParsedAiResponse {
  requestIdHex: string;
  /** 34-byte sha2-256 multihash. */
  cidHex: string;
  responseLength: number;
  /** Responder escrow key; absent on unsigned (78-byte) responses. */
  responderEscrowHex: string | null;
  /** Sealed answer carried inline; absent on body-less responses. */
  privateBody: Uint8Array | null;
}

/** Parses an AiResponse payload: 78 bytes, 174 bytes, or 174 + inline sealed body. */
export function parseAiResponse(payload: Uint8Array): ParsedAiResponse | null {
  let privateBody: Uint8Array | null = null;
  if (payload.length > AI_RESPONSE_V2_LEN) {
    if (payload.length < AI_RESPONSE_V2_LEN + AI_RESPONSE_EXT_HEADER_LEN + 1) return null;
    if (payload[AI_RESPONSE_V2_LEN] !== AI_RESPONSE_EXT_PRIVATE_BODY) return null;
    const len = new DataView(payload.buffer, payload.byteOffset + AI_RESPONSE_V2_LEN + 1, 4).getUint32(0, true);
    if (payload.length !== AI_RESPONSE_V2_LEN + AI_RESPONSE_EXT_HEADER_LEN + len) return null;
    privateBody = payload.subarray(AI_RESPONSE_V2_LEN + AI_RESPONSE_EXT_HEADER_LEN);
  } else if (payload.length !== AI_RESPONSE_V1_LEN && payload.length !== AI_RESPONSE_V2_LEN) {
    return null;
  }
  return {
    requestIdHex: bytesToHex(payload.subarray(0, 32)),
    cidHex: bytesToHex(payload.subarray(40, 74)),
    responseLength: new DataView(payload.buffer, payload.byteOffset + 74, 4).getUint32(0, true),
    responderEscrowHex: payload.length >= AI_RESPONSE_V2_LEN ? bytesToHex(payload.subarray(78, 110)) : null,
    privateBody,
  };
}
