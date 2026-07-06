// AiRequest encoding + transaction construction for on-chain inference.
//
// An inference request is a normal transaction placed on the AI-request
// subnetwork (0x03) whose payload carries the target model, generation limit,
// reward/fee split and the raw prompt. Miners scan block templates for these
// txs, run the model, and publish the answer as an AiResponse (subnetwork 0x04).
//
// The payload layout is byte-identical to the node/miner parser
// (keryx-node/inference/src/ai_payload.rs :: AiRequestPayload), little-endian:
//
//   offset  field             type
//   0       model_id          [u8; 32]
//   32      max_tokens        u32 LE
//   36      inference_reward  u64 LE   (sompi paid to the fulfilling miner)
//   44      priority_fee      u64 LE   (sompi burned; >= MIN_AI_REQUEST_PRIORITY_FEE)
//   52..    prompt            raw bytes (UTF-8)
//
// The SDK module (`kaspa`) is dependency-injected so this file has no runtime
// import of the WASM build and stays trivially unit-testable in Node.

import type { Transaction } from "../sdk/kaspa";

/** Subnetwork id marking a transaction as an AiRequest (hex, 20 bytes). */
export const SUBNETWORK_ID_AI_REQUEST_HEX =
  "0300000000000000000000000000000000000000";

/** Fixed-size header before the variable-length prompt (32 + 4 + 8 + 8). */
export const MIN_AI_REQUEST_PAYLOAD_LEN = 52;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export interface AiRequestFields {
  /** 32-byte model id, as raw bytes or a 64-char hex string. */
  modelId: Uint8Array | string;
  /** Prompt text (encoded UTF-8) or raw bytes. */
  prompt: string | Uint8Array;
  /** Generation cap (u32). */
  maxTokens: number;
  /** Sompi redirected to the fulfilling miner (u64). */
  inferenceReward: bigint;
  /** Sompi burned as network fee (u64). */
  priorityFee: bigint;
}

/**
 * Encode an AiRequest payload byte-for-byte as the node/miner expect it.
 * Returns the raw bytes to attach as the transaction payload.
 */
export function encodeAiRequestPayload(f: AiRequestFields): Uint8Array {
  const modelId =
    typeof f.modelId === "string" ? hexToBytes(f.modelId) : f.modelId;
  if (modelId.length !== 32) {
    throw new Error(`model_id must be 32 bytes, got ${modelId.length}`);
  }
  const prompt =
    typeof f.prompt === "string" ? new TextEncoder().encode(f.prompt) : f.prompt;
  if (f.maxTokens < 0 || f.maxTokens > 0xffff_ffff) {
    throw new Error("max_tokens out of u32 range");
  }

  const buf = new Uint8Array(MIN_AI_REQUEST_PAYLOAD_LEN + prompt.length);
  const dv = new DataView(buf.buffer);
  buf.set(modelId, 0);
  dv.setUint32(32, f.maxTokens >>> 0, true);
  dv.setBigUint64(36, f.inferenceReward, true);
  dv.setBigUint64(44, f.priorityFee, true);
  buf.set(prompt, MIN_AI_REQUEST_PAYLOAD_LEN);
  return buf;
}

export interface BuildAiRequestTxArgs extends AiRequestFields {
  /** UTXOs to fund the request (IUtxoEntry[]). */
  utxos: unknown[];
  /** Payment outputs, e.g. a single change output (IPaymentOutput[]). */
  outputs: unknown[];
  /**
   * Sompi to lock as transaction fee — for an AiRequest this is
   * `inferenceReward + priorityFee` (consensus splits it per the payload).
   */
  txFeeSompi: bigint;
  /** Optional sig-op count override. */
  sigOpCount?: number | null;
}

/**
 * Build (unsigned) an AiRequest transaction on subnetwork 0x03 carrying the
 * encoded payload. `kaspa` is the initialized WASM SDK module.
 */
export function buildAiRequestTx(
  kaspa: {
    createTransaction: (
      utxos: unknown[],
      outputs: unknown[],
      priorityFee: bigint,
      payload?: Uint8Array | string | null,
      sigOpCount?: number | null,
    ) => Transaction;
  },
  args: BuildAiRequestTxArgs,
): Transaction {
  const payload = encodeAiRequestPayload(args);
  const tx = kaspa.createTransaction(
    args.utxos,
    args.outputs,
    args.txFeeSompi,
    payload,
    args.sigOpCount ?? null,
  );
  // Mark the tx as an AiRequest. Setter accepts the 20-byte hex id.
  (tx as unknown as { subnetworkId: string }).subnetworkId =
    SUBNETWORK_ID_AI_REQUEST_HEX;
  return tx;
}
