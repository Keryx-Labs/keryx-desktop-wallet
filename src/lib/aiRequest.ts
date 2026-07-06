// AiRequest encoding + transaction construction for on-chain inference.
//
// An inference request is a normal transaction placed on the AI-request
// subnetwork (0x03) whose payload carries the target model, generation limit,
// reward/fee split and the raw prompt. Miners scan block templates for these
// txs, run the model, and publish the answer as an AiResponse (subnetwork 0x04).
//
// This mirrors the reference flow in keryx-ecosystem/lib/wallet.ts (used by the
// /infer page): the inference_reward is locked into an output[1] CSV-P2PK escrow
// payable to an *active miner* of the model; the priority_fee is burned as the
// tx fee. The difference here is that the transaction is assembled and signed
// with the audited wallet-core WASM SDK instead of a hand-rolled signer.
//
// Consensus rules enforced by the node (utxo_validation.rs :: check_ai_request_
// inference_rewards), all of which this builder must satisfy:
//   1. inference_reward >= base[model_id] + ceil(max_tokens/64) * TOKEN_STEP
//   2. priority_fee     >= MIN_AI_REQUEST_PRIORITY_FEE
//   3. tx fee (inputs - outputs) >= priority_fee   (priority_fee is burned)
//   4. outputs[1] is a CSV-P2PK script with value >= inference_reward
//
// The payload layout is byte-identical to keryx-node/inference/src/ai_payload.rs
// (little-endian): model_id[32] | max_tokens u32 | inference_reward u64 |
// priority_fee u64 | prompt.
//
// The SDK module (`kaspa`) is dependency-injected so this file has no runtime
// import of the WASM build and stays testable in Node.

import type { Transaction } from "../sdk/kaspa";

// ---------------------------------------------------------------------------
// Protocol constants (must match keryx-node)
// ---------------------------------------------------------------------------

/** Subnetwork id marking a transaction as an AiRequest (hex, 20 bytes). */
export const SUBNETWORK_ID_AI_REQUEST_HEX =
  "0300000000000000000000000000000000000000";

/** Fixed-size payload header before the variable-length prompt (32+4+8+8). */
export const MIN_AI_REQUEST_PAYLOAD_LEN = 52;
/** Absolute payload cap (node MAX_AI_REQUEST_PAYLOAD_LEN) ⇒ prompt <= 4044 B. */
export const MAX_AI_REQUEST_PAYLOAD_LEN = 4096;

/** Minimum burned priority fee: 0.3 KRX (MIN_AI_REQUEST_PRIORITY_FEE). */
export const MIN_AI_REQUEST_PRIORITY_FEE = 30_000_000n;
/** inference_reward surcharge per 64-token increment: 0.05 KRX. */
export const INFERENCE_REWARD_TOKEN_STEP = 5_000_000n;
/** Relative CSV lock on the escrow output, in blocks (challenge window). */
export const CHALLENGE_WINDOW_BLOCKS = 36_000;

// Script opcodes (mirror keryx-ecosystem/lib/wallet.ts).
const OP_DATA_32 = 0x20;
const OP_CHECKSIG = 0xac;
const OP_CSV = 0xb1;

// KIP-9 storage-mass guard (mirror of the ecosystem builder).
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n; // 1e12
const MASS_BUDGET = 80_000n; // headroom below the 100_000 standard limit
const COINBASE_MATURITY = 1000;

// ---------------------------------------------------------------------------
// Model registry (post-H2 OPoI v2 lineup) — model_id + base inference_reward.
// Values verified against INFERENCE_REWARD_MINIMUMS_V2_H2 in the node params.
// ---------------------------------------------------------------------------

export type ModelName =
  | "qwen3-1.7b"
  | "gemma-3-4b"
  | "dolphin-llama3-8b"
  | "qwen3-32b-abliterated"
  | "llama-3.3-70b-q2";

export interface ModelInfo {
  modelIdHex: string;
  baseRewardSompi: bigint;
  label: string;
}

export const MODELS: Record<ModelName, ModelInfo> = {
  "qwen3-1.7b": {
    modelIdHex: "4f21ddeb7d62bd2265bc54230d536ca3f1749927780f528c3c41fa2911df4d72",
    baseRewardSompi: 30_000_000n, // 0.3 KRX
    label: "Qwen3-1.7B (uncensored)",
  },
  "gemma-3-4b": {
    modelIdHex: "ad50ad0bd461d8ab44efc0214989eb33291685ef4ade22a0f4f217d03266d837",
    baseRewardSompi: 50_000_000n, // 0.5 KRX
    label: "Gemma-3-4B (uncensored)",
  },
  "dolphin-llama3-8b": {
    modelIdHex: "9421066a6400c98ba137114f7f4b7d4a2ddf13ab163a5de38c0184793af6313a",
    baseRewardSompi: 150_000_000n, // 1.5 KRX
    label: "Dolphin-Llama3-8B",
  },
  "qwen3-32b-abliterated": {
    modelIdHex: "65c6eb6fe18b9efd8060ab9d2d03bb9b01050a3b1378cbac000c5cc0acdc0d2a",
    baseRewardSompi: 250_000_000n, // 2.5 KRX
    label: "Qwen3-32B (abliterated)",
  },
  "llama-3.3-70b-q2": {
    modelIdHex: "6df46a78cbe4dc579f04dbd801f1a520b9eae28ce7b50c8da7874bfa3fb5108d",
    baseRewardSompi: 400_000_000n, // 4.0 KRX
    label: "Llama-3.3-70B-Q2 (abliterated)",
  },
};

/** effective inference_reward minimum = base + ceil(max_tokens/64) * TOKEN_STEP. */
export function computeInferenceReward(baseSompi: bigint, maxTokens: number): bigint {
  const steps = BigInt(Math.ceil(maxTokens / 64));
  return baseSompi + steps * INFERENCE_REWARD_TOKEN_STEP;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Payload + escrow script
// ---------------------------------------------------------------------------

export interface AiRequestFields {
  /** 32-byte model id, as raw bytes or a 64-char hex string. */
  modelId: Uint8Array | string;
  /** Prompt text (encoded UTF-8) or raw bytes. */
  prompt: string | Uint8Array;
  /** Generation cap (u32). */
  maxTokens: number;
  /** Sompi redirected to the fulfilling miner (u64) — goes into the escrow. */
  inferenceReward: bigint;
  /** Sompi burned as network fee (u64). */
  priorityFee: bigint;
}

/**
 * Encode an AiRequest payload byte-for-byte as the node/miner expect it.
 * Equivalent to encodeBinaryAiPayload() in keryx-ecosystem/lib/wallet.ts.
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
  if (buf.length > MAX_AI_REQUEST_PAYLOAD_LEN) {
    throw new Error(
      `payload ${buf.length} B exceeds MAX_AI_REQUEST_PAYLOAD_LEN ${MAX_AI_REQUEST_PAYLOAD_LEN}`,
    );
  }
  const dv = new DataView(buf.buffer);
  buf.set(modelId, 0);
  dv.setUint32(32, f.maxTokens >>> 0, true);
  dv.setBigUint64(36, f.inferenceReward, true);
  dv.setBigUint64(44, f.priorityFee, true);
  buf.set(prompt, MIN_AI_REQUEST_PAYLOAD_LEN);
  return buf;
}

/**
 * Build the CSV-P2PK escrow script hex for output[1].
 * Format: <seq_len> <seq_bytes_LE> OP_CSV OP_DATA_32 <pubkey_32> OP_CHECKSIG
 * Ported verbatim from keryx-ecosystem/lib/wallet.ts :: buildEscrowScript,
 * which mirrors the Rust build_escrow_script().
 */
export function buildEscrowScript(
  pubkeyHex: string,
  challengeWindow = CHALLENGE_WINDOW_BLOCKS,
): string {
  const pubkey = hexToBytes(pubkeyHex); // 32-byte x-coordinate
  if (pubkey.length !== 32) {
    throw new Error(`escrow pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  // Minimal little-endian encoding of challengeWindow.
  const seqBytes: number[] = [];
  let n = challengeWindow;
  while (n > 0) {
    seqBytes.push(n & 0xff);
    n = Math.floor(n / 256);
  }
  const script = new Uint8Array(1 + seqBytes.length + 1 + 1 + 32 + 1);
  let i = 0;
  script[i++] = seqBytes.length; // data-push length for the sequence
  for (const b of seqBytes) script[i++] = b;
  script[i++] = OP_CSV;
  script[i++] = OP_DATA_32;
  script.set(pubkey, i);
  i += 32;
  script[i++] = OP_CHECKSIG;
  return bytesToHex(script);
}

// ---------------------------------------------------------------------------
// UTXO selection (mass-aware) + transaction assembly
// ---------------------------------------------------------------------------

/** Minimal UTXO shape needed to fund and sign a request. */
export interface RequestUtxo {
  transactionId: string;
  index: number;
  amountSompi: bigint;
  scriptPublicKey: { version: number; script: string };
  blockDaaScore: bigint;
  isCoinbase: boolean;
}

export interface SelectedUtxos {
  selected: RequestUtxo[];
  totalIn: bigint;
  /** change value for output[0]; 0 means the change is folded into the fee. */
  changeSompi: bigint;
  dropChange: boolean;
}

/**
 * Select mature UTXOs (largest first) until the change output is large enough
 * that the KIP-9 storage mass stays under the standard limit. Mirrors the
 * pooling logic of the ecosystem builder. `totalNeeded = priorityFee + reward`.
 */
export function selectUtxosForRequest(
  utxos: RequestUtxo[],
  priorityFee: bigint,
  inferenceReward: bigint,
  currentDaaScore: bigint,
): SelectedUtxos {
  const candidates = utxos
    .filter(
      (u) =>
        u.blockDaaScore > 0n &&
        !(
          u.isCoinbase &&
          currentDaaScore > 0n &&
          u.blockDaaScore + BigInt(COINBASE_MATURITY) > currentDaaScore
        ),
    )
    .sort((a, b) => (b.amountSompi > a.amountSompi ? 1 : -1));

  const totalNeeded = priorityFee + inferenceReward;
  const escrowMass =
    inferenceReward > 0n ? STORAGE_MASS_PARAMETER / inferenceReward : 0n;

  const selected: RequestUtxo[] = [];
  let totalIn = 0n;
  for (const c of candidates) {
    selected.push(c);
    totalIn += c.amountSompi;
    const change = totalIn - totalNeeded;
    if (change <= 0n) continue;
    if (STORAGE_MASS_PARAMETER / change + escrowMass <= MASS_BUDGET) break;
  }

  if (totalIn <= totalNeeded) {
    throw new Error(
      `Insufficient funds: need more than ${totalNeeded} sompi (have ${totalIn})`,
    );
  }

  let changeSompi = totalIn - totalNeeded;
  // Last resort: a dust change that would breach the mass limit is folded into
  // the fee. NOTE: consensus hard-requires outputs[1] = escrow, so we must keep
  // a real output[0]; dropping change would move the escrow to index 0 and be
  // rejected (AiRequestMissingEscrowOutput). We therefore never drop the change
  // when an escrow is present — instead the caller should pool more UTXOs.
  const dropChange =
    inferenceReward > 0n &&
    STORAGE_MASS_PARAMETER / changeSompi + escrowMass > MASS_BUDGET;
  if (dropChange) {
    throw new Error(
      "change would be dust under the storage-mass limit; pool more/larger UTXOs " +
        "(cannot fold change into fee: escrow must stay at output[1])",
    );
  }

  return { selected, totalIn, changeSompi, dropChange: false };
}

export interface BuildAiRequestTxArgs extends AiRequestFields {
  utxos: RequestUtxo[];
  /** Change address (the requester's own receive address). */
  changeAddress: string;
  /** x-only pubkey (32 B hex) of an active miner of the model — the escrow payee. */
  minerEscrowPubkeyHex: string;
  /** Current virtual DAA score, for coinbase maturity filtering. */
  currentDaaScore: bigint;
}

/** Minimal SDK surface this builder needs (subset of the WASM module). */
export interface KaspaTxSdk {
  payToAddressScript: (address: string) => { version: number; script: string };
  Transaction: new (itx: unknown) => Transaction;
}

/**
 * Build (unsigned) an AiRequest transaction on subnetwork 0x03:
 *   inputs  = selected UTXOs
 *   output0 = change → requester
 *   output1 = escrow (CSV-P2PK, value = inferenceReward) → active miner
 *   fee     = priorityFee (burned)
 *   payload = encoded AiRequest
 * Sign the result with the SDK (signTransaction) using the account keys.
 */
export function buildAiRequestTx(
  kaspa: KaspaTxSdk,
  args: BuildAiRequestTxArgs,
): Transaction {
  if (args.priorityFee < MIN_AI_REQUEST_PRIORITY_FEE) {
    throw new Error(
      `priority_fee ${args.priorityFee} below minimum ${MIN_AI_REQUEST_PRIORITY_FEE}`,
    );
  }
  const payload = encodeAiRequestPayload(args);
  const { selected, changeSompi } = selectUtxosForRequest(
    args.utxos,
    args.priorityFee,
    args.inferenceReward,
    args.currentDaaScore,
  );

  const changeScript = kaspa.payToAddressScript(args.changeAddress);
  const escrowScriptHex = buildEscrowScript(args.minerEscrowPubkeyHex);

  const itx = {
    version: 0,
    inputs: selected.map((u) => ({
      previousOutpoint: { transactionId: u.transactionId, index: u.index },
      signatureScript: "",
      sequence: 0n,
      sigOpCount: 1,
      utxo: {
        address: undefined,
        amount: u.amountSompi,
        scriptPublicKey: u.scriptPublicKey,
        blockDaaScore: u.blockDaaScore,
        isCoinbase: u.isCoinbase,
        outpoint: { transactionId: u.transactionId, index: u.index },
      },
    })),
    outputs: [
      // output[0] = change → requester
      {
        value: changeSompi,
        scriptPublicKey: { version: changeScript.version, script: changeScript.script },
      },
      // output[1] = escrow → miner (CSV-P2PK)
      { value: args.inferenceReward, scriptPublicKey: { version: 0, script: escrowScriptHex } },
    ],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_AI_REQUEST_HEX,
    gas: 0n,
    payload: bytesToHex(payload),
  };

  return new kaspa.Transaction(itx);
}
