// Match an on-chain AiResponse (subnetwork 0x04) back to the AiRequest we sent,
// and recover its IPFS result CID — all over wRPC, no keryx-api / HTTP.
//
// The response references the request by `request_hash = blake2b(request_payload)[0..32]`
// (blake2b default 64-byte output, truncated — validated against a real mainnet
// payload_prefix). AiResponsePayload layout (keryx-node/inference/src/ai_payload.rs):
//   0    request_hash          32 bytes
//   32   challenge_window_end  u64
//   40   response_ipfs_cid     34-byte multihash [0x12, 0x20, <32 digest>]
//   74   response_length       u32
// V1 = 78 bytes; V2 (OPoI v2) = 142 bytes (adds model_id + commitment, same prefix).

import { blake2b } from "@noble/hashes/blake2.js";
import { hexToBytes, bytesToHex } from "./aiRequest";

export const SUBNETWORK_ID_AI_RESPONSE_HEX =
  "0400000000000000000000000000000000000000";

/** request_hash (32-byte hex) = first 32 bytes of blake2b(payload) [default 64-byte digest]. */
export function aiRequestHashHex(payload: Uint8Array): string {
  return bytesToHex(blake2b(payload).slice(0, 32));
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc encode (Bitcoin alphabet). Ported from keryx-api base58btc_encode. */
function base58btcEncode(input: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of input) {
    if (b === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/**
 * Parse an AiResponse payload: returns the request_hash it answers and the
 * IPFS CIDv0 of the result, or null if the payload isn't a well-formed response.
 */
export function parseAiResponse(
  payloadHex: string,
): { requestHashHex: string; cidV0: string } | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(payloadHex);
  } catch {
    return null;
  }
  if (bytes.length !== 78 && bytes.length !== 142) return null;
  const cid = bytes.subarray(40, 74); // 34-byte sha2-256 multihash
  if (cid.length !== 34 || cid[0] !== 0x12 || cid[1] !== 0x20) return null;
  return {
    requestHashHex: bytesToHex(bytes.subarray(0, 32)),
    cidV0: base58btcEncode(cid),
  };
}

/** Public IPFS gateway URL for a CIDv0 (opened externally — the node doesn't serve IPFS). */
export function ipfsUrl(cidV0: string): string {
  return `https://keryx-labs.com/ipfs/${cidV0}`;
}
