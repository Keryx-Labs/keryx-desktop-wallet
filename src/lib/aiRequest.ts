// AiRequest encoding + transaction construction for on-chain inference.
//
// An inference request is a normal transaction placed on the AI-request
// subnetwork (0x03) whose payload carries the target model, generation limit,
// reward/fee split and the raw prompt. Miners scan block templates for these
// txs, run the model, and publish the answer as an AiResponse (subnetwork 0x04).
//
// This mirrors the reference flow in keryx-ecosystem/lib/wallet.ts (used by the
// /infer page): the inference_reward is locked into output[1], the keyless
// reward vault, and the chain mints it to the first accepted responder; the
// priority_fee is burned as the tx fee. The difference here is that the
// transaction is assembled and signed with the audited wallet-core WASM SDK
// instead of a hand-rolled signer.
//
// Consensus rules enforced by the node (utxo_validation.rs :: check_ai_request_
// inference_rewards), all of which this builder must satisfy:
//   1. inference_reward >= base[model_id] + ceil(max_tokens/64) * TOKEN_STEP
//   2. priority_fee     >= MIN_AI_REQUEST_PRIORITY_FEE
//   3. tx fee (inputs - outputs) >= priority_fee   (priority_fee is burned)
//   4. outputs[1] is the vault script (version 0) with value >= inference_reward
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
/** Keyless reward vault script (OP_RETURN "aivault"), output[1] of every request. */
export const INFERENCE_VAULT_SCRIPT_HEX = "6a0761697661756c74";

// KIP-9 storage-mass guard (mirror of the ecosystem builder).
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n; // 1e12
const MASS_BUDGET = 80_000n; // headroom below the 100_000 standard limit
const COINBASE_MATURITY = 1000;

// "Private" livefeed marker.
// Desktop-wallet requests should not surface on the public inference livefeed
// (keryx-api /api/v1/infer). The node offers no field to tag a request, so we
// carve an extra self-send output[2] that the miner ignores (it only reads the
// payload + vault output[1]) and the node accepts (extra outputs beyond the
// vault are allowed). keryx-api recognises an AiRequest carrying >2 outputs as
// wallet-originated and keeps it off the feed. The value is change back to the
// requester — NOT a cost — sized to stay under the KIP-9 mass budget.
// This is cosmetic (the tx is still on-chain and inspectable), not privacy.
export const PRIVATE_MARKER_SOMPI = 50_000_000n; // 0.5 KRX, self-send (reclaimable)

// ---------------------------------------------------------------------------
// Model registry (H6 lineup, tiers 0..4) — model_id + base inference_reward.
// Values verified against INFERENCE_REWARD_MINIMUMS_V2_H6 in the node params.
// ---------------------------------------------------------------------------

export type ModelName =
  | "qwen3.5-9b-abliterated"
  | "glm-4-9b-0414"
  | "gemma-4-12b-abliterated"
  | "qwen3.6-27b"
  | "kimi-linear-48b";

export interface ModelInfo {
  modelIdHex: string;
  baseRewardSompi: bigint;
  label: string;
}

export const MODELS: Record<ModelName, ModelInfo> = {
  "qwen3.5-9b-abliterated": {
    modelIdHex: "bd34568cd89f5f19c6c3a6e1a61b929bc868709409eaad8e672d85f3c1eb5710",
    baseRewardSompi: 100_000_000n, // 1.0 KRX
    label: "Qwen3.5-9B (uncensored)",
  },
  "glm-4-9b-0414": {
    modelIdHex: "fa2f13be0850e26c5ce86c7ac79da85e300c1da8b3290f9a18d47105f1f2140a",
    baseRewardSompi: 150_000_000n, // 1.5 KRX
    label: "GLM-4-9B (uncensored)",
  },
  "gemma-4-12b-abliterated": {
    modelIdHex: "399984045600f7d58d1b2cf01e6a4bf466fa15c7ac31bd0dd1a71e003b617cc6",
    baseRewardSompi: 200_000_000n, // 2.0 KRX
    label: "Gemma-4-12B (uncensored)",
  },
  "qwen3.6-27b": {
    modelIdHex: "b8bdc01fa407eab943e4fefc807483b39f8142785256049e1f559698a5284746",
    baseRewardSompi: 250_000_000n, // 2.5 KRX
    label: "Qwen3.6-27B (uncensored)",
  },
  "kimi-linear-48b": {
    modelIdHex: "3dc09358ad75c6ef0c9c86ee4f47c4d6acda961fecbd0e4f9cf55e8f0fdffddb",
    baseRewardSompi: 400_000_000n, // 4.0 KRX
    label: "Kimi-Linear-48B (uncensored)",
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
// Payload
// ---------------------------------------------------------------------------

export interface AiRequestFields {
  /** 32-byte model id, as raw bytes or a 64-char hex string. */
  modelId: Uint8Array | string;
  /** Prompt text (encoded UTF-8) or raw bytes. */
  prompt: string | Uint8Array;
  /** Generation cap (u32). */
  maxTokens: number;
  /** Sompi locked in the vault for the responder (u64). */
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
  /** change value for output[0] (already net of the private marker, if any). */
  changeSompi: bigint;
  /** value of the extra self-send marker output[2]; 0 when not private. */
  markerSompi: bigint;
  dropChange: boolean;
}

/**
 * Select mature UTXOs (largest first) until the change output is large enough
 * that the KIP-9 storage mass stays under the standard limit. Mirrors the
 * pooling logic of the ecosystem builder. `totalNeeded = priorityFee + reward`.
 *
 * `markerSompi > 0` (private mode) carves a self-send output[2] out of the
 * change: the change (output[0]) becomes `totalIn - needed - marker`, and the
 * mass budget must cover output[0] + vault + the marker together.
 */
export function selectUtxosForRequest(
  utxos: RequestUtxo[],
  priorityFee: bigint,
  inferenceReward: bigint,
  currentDaaScore: bigint,
  markerSompi: bigint = 0n,
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

  // What actually leaves the wallet: the burned fee + the vaulted reward. The
  // private marker is a self-send, so it stays with the requester but must be
  // carved out of the change (output[0] = totalIn - leavesWallet - marker).
  const leavesWallet = priorityFee + inferenceReward;
  const vaultMass =
    inferenceReward > 0n ? STORAGE_MASS_PARAMETER / inferenceReward : 0n;
  const markerMass =
    markerSompi > 0n ? STORAGE_MASS_PARAMETER / markerSompi : 0n;

  const selected: RequestUtxo[] = [];
  let totalIn = 0n;
  for (const c of candidates) {
    selected.push(c);
    totalIn += c.amountSompi;
    const change = totalIn - leavesWallet - markerSompi;
    if (change <= 0n) continue;
    if (
      STORAGE_MASS_PARAMETER / change + vaultMass + markerMass <=
      MASS_BUDGET
    )
      break;
  }

  const changeSompi = totalIn - leavesWallet - markerSompi;
  if (changeSompi <= 0n) {
    throw new Error(
      `Insufficient funds: need more than ${leavesWallet + markerSompi} sompi (have ${totalIn})`,
    );
  }

  // A dust change that would breach the mass limit cannot be folded into the
  // fee: consensus hard-requires outputs[1] = vault, so output[0] must stay
  // real (dropping it would move the vault to index 0 → AiRequestMissingEscrow-
  // Output). The caller must pool more/larger UTXOs instead.
  const dropChange =
    inferenceReward > 0n &&
    STORAGE_MASS_PARAMETER / changeSompi + vaultMass + markerMass > MASS_BUDGET;
  if (dropChange) {
    throw new Error(
      "change would be dust under the storage-mass limit; pool more/larger UTXOs " +
        "(cannot fold change into fee: vault must stay at output[1])",
    );
  }

  return { selected, totalIn, changeSompi, markerSompi, dropChange: false };
}

export interface BuildAiRequestTxArgs extends AiRequestFields {
  utxos: RequestUtxo[];
  /** Change address (the requester's own receive address). */
  changeAddress: string;
  /** Current virtual DAA score, for coinbase maturity filtering. */
  currentDaaScore: bigint;
  /**
   * Keep this request off the public inference livefeed. Adds a self-send
   * output[2] (change back to the requester) that keryx-api recognises to
   * exclude the request from /api/v1/infer. Cosmetic, not confidential.
   * Desktop-wallet requests default to private.
   */
  isPrivate?: boolean;
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
 *   output1 = vault (keyless, value = inferenceReward) → first accepted responder
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
  const marker = args.isPrivate ? PRIVATE_MARKER_SOMPI : 0n;
  const { selected, changeSompi, markerSompi } = selectUtxosForRequest(
    args.utxos,
    args.priorityFee,
    args.inferenceReward,
    args.currentDaaScore,
    marker,
  );

  const changeScript = kaspa.payToAddressScript(args.changeAddress);
  const changeSpk = { version: changeScript.version, script: changeScript.script };

  const outputs = [
    // output[0] = change → requester
    { value: changeSompi, scriptPublicKey: changeSpk },
    // output[1] = reward → keyless vault
    { value: args.inferenceReward, scriptPublicKey: { version: 0, script: INFERENCE_VAULT_SCRIPT_HEX } },
  ];
  // output[2] = private-livefeed marker: a self-send back to the requester that
  // keryx-api uses to keep the request off the public feed. Reclaimable change,
  // ignored by the miner. See PRIVATE_MARKER_SOMPI.
  if (markerSompi > 0n) {
    outputs.push({ value: markerSompi, scriptPublicKey: changeSpk });
  }

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
    outputs,
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_AI_REQUEST_HEX,
    gas: 0n,
    payload: bytesToHex(payload),
  };

  return new kaspa.Transaction(itx);
}
