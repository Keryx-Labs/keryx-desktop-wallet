// Parse the miner-advertised inference capabilities from a coinbase payload.
//
// Miners tag their coinbase with two ASCII fields the requester needs to route
// an AiRequest to an active provider:
//   /escrow:<64 hex>          — the miner's 32-byte Schnorr escrow pubkey
//   /ai:cap:<id>,<id>,...      — the model_ids (64 hex each) it currently serves
//
// A request to model X must lock its reward escrow to the escrow pubkey of a
// miner whose coinbase declares X in /ai:cap: — otherwise no one can claim the
// escrow and the request goes unanswered.
//
// Ported byte-for-byte from keryx-api/src/indexer.rs (extract_escrow_pubkey /
// extract_ai_caps): skip the 19-byte binary coinbase header, find the marker,
// read until the next '/', validate hex. Markers + data are ASCII, so we scan a
// byte-preserving latin1 view of the payload.

import { hexToBytes } from "./aiRequest";

/** Binary coinbase header length skipped before the ASCII extra-data fields. */
const COINBASE_HEADER_SKIP = 19;

function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
}

function readField(payloadHex: string, marker: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(payloadHex);
  } catch {
    return null;
  }
  const skip = Math.min(COINBASE_HEADER_SKIP, bytes.length);
  const s = bytesToLatin1(bytes.subarray(skip));
  const pos = s.indexOf(marker);
  if (pos < 0) return null;
  const start = pos + marker.length;
  let end = s.indexOf("/", start);
  if (end < 0) end = s.length;
  return s.slice(start, end).trim();
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The miner's escrow pubkey (64-hex, lowercased), or null if absent/malformed. */
export function extractEscrowPubkey(payloadHex: string): string | null {
  const v = readField(payloadHex, "/escrow:");
  if (!v) return null;
  const p = v.toLowerCase();
  return HEX64.test(p) ? p : null;
}

/** The model_ids (64-hex, lowercased) the coinbase declares it serves. */
export function extractAiCaps(payloadHex: string): string[] {
  const v = readField(payloadHex, "/ai:cap:");
  if (!v) return [];
  const ids = v.split(",").map((s) => s.trim().toLowerCase());
  return ids.every((id) => HEX64.test(id)) ? ids : [];
}

/**
 * If this coinbase belongs to a miner that serves `modelIdHex`, return its
 * escrow pubkey (the valid escrow payee for a request to that model); else null.
 */
export function escrowForModel(
  payloadHex: string,
  modelIdHex: string,
): string | null {
  const target = modelIdHex.toLowerCase();
  if (!extractAiCaps(payloadHex).includes(target)) return null;
  return extractEscrowPubkey(payloadHex);
}
