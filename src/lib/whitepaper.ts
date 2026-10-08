export const WHITEPAPER_MD = `# Keryx: A BlockDAG Protocol for Proof-of-Model Mining and Uncensored AI Inference

**Version 1.4 — August 2026**

*keryx-labs.com*

---

## Abstract

We propose Keryx, a high-throughput BlockDAG protocol whose proof-of-work *is* model possession. Miners do not hash over an arbitrary working set — they hash over the weights of an open language model they must actually hold in GPU memory. A GPU that does not carry the weights cannot produce a valid block.

The core mechanism, **Proof-of-Model (PoM)**, is a memory-hard proof-of-work whose data-dependent reads land inside the model file itself. Every block header commits to the final state of a possession walk over those weights, and the block body carries a proof that any node re-verifies byte-exactly. Possession is therefore established at the consensus level, without a trusted party, a committee, or an attestation service. One GPU holds one model tier, and the tier a card can prove scales with its VRAM.

The network runs at 10 blocks per second via the GHOSTDAG protocol. The native currency KRX pays miners for proven possession, pays them again for serving inference to users, and is burned on every fee — a closed loop around scarce, provably held AI capacity.

Inference results are stored on IPFS; only a 34-byte CID is committed on-chain. Per-model economic minimums are enforced by consensus, and a **service bond** — collateral routed from the block subsidy and locked by a relative timelock — is struck and escalated to suspension when a miner advertises a model and then fails to serve it.

---

## 1. Introduction

The dominant paradigm for AI access in 2026 is centralization. A handful of companies control the models, the inference endpoints, and the content policies. An autonomous agent running on a smart contract cannot call GPT without trusting a private API gateway. A user in a jurisdiction deemed undesirable may find their access silently revoked. The compute exists everywhere; the permission does not.

Keryx's premise is simple: **make the model weights the thing miners compete over**. A GPU cannot win a Keryx block by hashing an arbitrary buffer; it wins by walking the weights of a real open model it holds in VRAM, and by proving that walk to every other node. Mining capacity and inference capacity become the same scarce resource, measured in the same units.

The consequence is that the network's inference capacity is not a promise — it is a *lower bound* readable from the chain. Every block tells you a specific GPU held a specific model at a specific moment. A miner who advertises a model they cannot serve loses their bond and is suspended.

This is not an off-chain oracle. There is no multisig committee, no reputation score, no centralized aggregator, and no attestation service to trust.

> *"Intelligence is the message. Keryx is the messenger."*

---

## 2. Use Cases

### 2.1 Autonomous On-Chain Agents

**Every AI agent on Solana and Ethereum is, today, fully centralized.** The transactions are on-chain — but the intelligence behind them is not. The moment an agent has to reason, interpret language, or make a judgment call, it reaches off-chain to a Web2 API: OpenAI, Anthropic, some hosted endpoint. A single company can throttle it, censor it, log every prompt, or revoke the key. The "autonomous on-chain agent" is only autonomous until that API call.

This is a structural gap, not an implementation detail. Smart contracts on Ethereum, Solana, or any EVM-compatible chain are deterministic by design — they cannot reason, interpret language, or decide. So the decision-making is outsourced, and with it go the trust assumptions, the censorship surface, and the single point of failure.

Keryx closes the gap. An agent broadcasts an \`AiRequest\` on-chain; a miner executes the inference; the result comes back as an on-chain \`AiResponse\` — no HTTP call, no API key, no corporate gateway. The serving miner has proven, at the consensus level, that they hold the model they answered with, and they forfeit collateral if they refuse to answer at all. The agent treats *capacity and availability* as on-chain facts rather than vendor promises — see §8.2 for what this does and does not cover. The chain is the oracle.

This is the missing primitive for truly autonomous agents: a trustless, permissionless, economically-enforced AI call.

### 2.2 Uncensored Knowledge Access

The dominant LLM providers apply content filters that vary by jurisdiction, topic, and business interest. Legal research, medical questions, political analysis, and security topics are routinely refused, redacted, or distorted depending on who is asking and from where.

Keryx miners run open-weight models with no content policy enforced at the protocol level. The network has no operator who can receive a compliance order. There is no account to suspend. A query submitted to Keryx is processed by whichever miner includes it in a block — a global, rotating set of independent operators with no shared policy.

This does not mean Keryx is designed for harmful use. It means the network cannot discriminate: a nurse asking about drug interactions, a journalist researching extremist rhetoric, and a lawyer analyzing case law all get the same neutral treatment.

### 2.3 Privacy-Preserving Inference *(Roadmap)*

In the current implementation, prompts submitted as \`AiRequest\` transactions are included in the BlockDAG as binary payloads. While the raw bytes are technically readable by a node operator with archival access, they are not human-readable in standard block explorers and are pruned from most nodes after ~30 hours.

A future upgrade will introduce proper cryptographic privacy: the user encrypts their prompt with the miner's public key before broadcasting the \`AiRequest\`. The miner decrypts and executes locally, publishing only the result commitment. The plaintext prompt never appears on-chain in any form.

Encrypted inference is a research track of its own: the possession proof covers the model, and the prompt stays private to the serving miner. Encrypting the prompt hides what was asked while leaving the published result independently retrievable.

---

## 3. Background: The GHOSTDAG Protocol

Keryx inherits its consensus layer from [Kaspa](https://kaspa.org), which implements the GHOSTDAG protocol — a generalization of Nakamoto consensus to directed acyclic graphs (BlockDAGs).

### 3.1 BlockDAG vs Blockchain

In a traditional blockchain, blocks that are mined simultaneously create forks, and all but one are orphaned. This limits throughput because a higher block rate increases the orphan rate, which encourages mining pool centralization.

GHOSTDAG resolves this by allowing all blocks to coexist in the DAG. Rather than discarding parallel blocks, the protocol orders them using the **k-cluster** concept: given a parameter *k*, the DAG is partitioned into a "blue" set (honest, well-connected blocks) and a "red" set (blocks outside the *k*-anticone of the blue set). The linear chain extracted from the blue set is the canonical ordering.

### 3.2 Keryx Network Parameters

| Parameter | Value |
|---|---|
| Block rate (BPS) | 10 blocks/second |
| Target block time | 100 ms |
| GHOSTDAG k | 124 |
| Max block parents | 16 |
| Merge depth | 36,000 blocks (~1 hour) |
| Finality depth | 432,000 blocks (~12 hours) |
| Pruning depth | 1,080,000 blocks (~30 hours) |

At 10 BPS, the network produces 864,000 blocks per day. The high block rate allows AI inference tasks to be submitted, executed, and finalized within seconds rather than minutes.

---

## 4. Proof of Work: KeryxHash → Proof-of-Model

Keryx launched with **KeryxHash**, a modified version of kHeavyHash — the memory-hard hash function from Kaspa — with additions designed to maintain ASIC resistance and establish Keryx's independent identity. At the PoM hardfork (DAA 37,780,000) the matrix-multiply core is replaced by **Proof-of-Model**, which ties the proof-of-work directly to possession of the model weights (Section 4.3). This section documents both: the KeryxHash design that secured the chain from genesis, and the PoM design that supersedes it.

### 4.1 The kHeavyHash Foundation

kHeavyHash builds on cSHAKE256 (domain \`"HeavyHash"\`) and requires miners to perform a 64×64 matrix multiplication per hash attempt. The matrix is derived from the block header via an XoShiRo256++ pseudo-random number generator, changing with each block. This makes the algorithm memory-hard in a way that GPUs handle efficiently but ASICs cannot profitably optimize.

### 4.2 KeryxHash Modifications

**Modification 1 — KERYX_MATRIX_SALT**

Before seeding the XoShiRo256++ PRNG, Keryx XORs the pre-PoW hash with a 32-byte domain separator:

\`\`\`
salt = b"KERYX:KeryxHash-v1:2026-04-12:xx"
seed = pre_pow_hash XOR salt
matrix = XoShiRo256++(seed)
\`\`\`

This ensures KeryxHash matrices are completely different from Kaspa's for the same input, preventing any Kaspa-targeted hardware from being repurposed on Keryx.

**Modification 2 — wave_mix**

After the matrix multiplication and before the final cSHAKE256 call, Keryx inserts a 4-round ARX (Add-Rotate-XOR) mixing step over four 64-bit words:

\`\`\`
ROUNDS = 4
KEYS   = [0x9e3779b97f4a7c15, 0x6c62272e07bb0142,
          0xb5ad4eceda1ce2a9, 0x243f6a8885a308d3]
ROTL   = [17, 31, 47, 13]

for r in 0..4:
    w[0] = rotl(w[0] + w[1], ROTL[0]) XOR KEYS[r % 4]
    w[2] = rotl(w[2] + w[3], ROTL[2]) XOR KEYS[(r+2) % 4]
    w[1] = rotl(w[1] + w[2], ROTL[1]) XOR KEYS[(r+1) % 4]
    w[3] = rotl(w[3] + w[0], ROTL[3]) XOR KEYS[(r+3) % 4]
\`\`\`

wave_mix is purely arithmetic (no memory accesses, no lookup tables), adding approximately 32 ARX operations per hash — negligible overhead on a GPU warp but meaningful additional circuit complexity for a dedicated ASIC.

**Modification 3 — KERYX_MATRIX_SALT_V2 (Hardfork — DAA 17,275,000)**

At DAA score 17,275,000, Keryx activated a second domain separator. From this point, the PoW salt switches to:

\`\`\`
salt_v2 = b"KERYX:KeryxHash-v2:2026-05-29:xx"  -- 32 bytes
seed    = pre_pow_hash XOR salt_v2
matrix  = XoShiRo256++(seed)
\`\`\`

The active salt is selected per block based on its \`daa_score\`: blocks with \`daa_score < 17,275,000\` use SALT v1; blocks at or above use SALT v2. Miners that did not update to v0.2.9+ produce a different matrix and their blocks are rejected. Node v1.2.2 and miner v0.2.9 are the minimum required versions.

The full KeryxHash pipeline is:

\`\`\`
1. Expand block hash → 64 nibbles
2. Select salt: v1 (daa_score < 17,275,000) or v2 (daa_score ≥ 17,275,000)
3. Generate 64×64 matrix (XoShiRo256++ seeded with hash XOR salt)
4. matrix × nibbles → 32-byte product
5. product XOR hash
6. product = wave_mix(product)       ← Keryx addition
7. result = cSHAKE256("HeavyHash", product)
\`\`\`

### 4.3 Proof-of-Model (Hardfork — DAA 37,780,000)

At DAA score 37,780,000 (mainnet 2026-06-26 18:00 UTC) the matrix-multiply core of KeryxHash is replaced by **Proof-of-Model (PoM)**. The motivation is structural: under KeryxHash a miner could hash without ever loading a model, satisfying the inference requirement on a separate, low-end device or even on CPU. PoM closes that gap by making the proof-of-work itself depend on the model weights.

**The weights are the scratchpad.** PoM keeps the memory-hard philosophy of kHeavyHash but swaps the per-block 64×64 random matrix for the miner's resident model. The PoW becomes a data-dependent *walk* over the quantized weight tensors: each step reads a location derived from the running hash, mixes the bytes it finds there, and derives the next location from the result. Because the next read depends on the value just read, the walk cannot be precomputed and cannot be served from a partial copy — a miner missing even a fraction of the weights from GPU memory is forced to fetch them across the PCIe bus and slows down by orders of magnitude. Possession of the *entire* tier's weights in VRAM is therefore the only competitive configuration.

**Walk v2 — hardened transition (H5 hardfork, DAA 59,009,037 — 2026-07-25).** The original walk folded the four 64-bit words of each 32-byte chunk with XOR before a single mix step, so only the 8-byte XOR of a chunk was load-bearing. In July 2026 a modified miner exploited this in the wild: by precomputing that per-chunk fold it could mine competitively while holding a compressed digest instead of the weights, defeating the possession property. The H5 hardfork replaces the transition: the mixer is now **chained through every word** (\`state = mix64(state ^ w_i)\`), making all 32 bytes of each chunk load-bearing and order-dependent — no sub-linear digest of the weights can stand in for them. Verification is unchanged in nature (byte-exact, deterministic, Merkle openings against \`R_T\`). The same gate bundles a **parallel-block cap** (at most 20 blocks per selected parent are counted in the DAA score and paid by the coinbase; the surplus is demoted to the non-DAA mergeset, neutralizing sibling-flood spam without non-deterministic rejection), the **pinned tier-0 swap** to Qwen3-8B-abliterated (raising the tier-0 VRAM floor to 6 GB), and a difficulty reset for the relaunch. Two follow-up seed-salt gates (DAA 59,027,921 and 59,170,000) rotate the walk-seed derivation to anchor the relaunched chain and permanently invalidate blocks produced by pre-H5 binaries.

**One GPU = one tier.** The tier a miner mines is the largest model it can hold resident. An 8 GB card walks Qwen3.5-9B-abliterated; a 12 GB card walks GLM-4-9B; a 16 GB card walks Gemma-4-12B-abliterated; a 24 GB card walks Qwen3.6-27B; a 32 GB card walks Kimi-Linear-48B (Q4). This is enforced, not declared: the block's PoM solution embeds a Fiat-Shamir-selected set of weight chunks whose Merkle openings the node verifies against a per-tier weight root \`R_T\` published in the consensus parameters. The verification is **byte-exact and fully deterministic** — there is no floating-point tolerance involved — so it is pool-safe and fork-proof: a node validates a PoM block from the header and the weight root alone, with no trust in the producer.

**Scope.** PoM operates at the consensus level and settles one question completely: *which model this GPU holds*. The answer is byte-exact, re-derivable by every node from the block alone, and independent of anything the miner asserts.

### 4.4 Hardware Targets

PoM ties the proof-of-work directly to the model weights: both the weight walk and the model inference run through the CUDA runtime and a custom CUDA kernel. The reference Keryx miner is built on CUDA and requires an **NVIDIA GPU (SM 7.5+, driver ≥ 535)**. Which tier a card mines is set purely by its VRAM, not by its architecture.

**Summary of post-hardfork GPU compatibility:**

| Hardware (VRAM) | Highest tier it can mine | The one model it mines *and* serves |
|---|---|---|
| NVIDIA 32 GB | tier 4 | Kimi-Linear-48B (Q4) |
| NVIDIA 24 GB | tier 3 | Qwen3.6-27B (Q4) |
| NVIDIA 16 GB | tier 2 | Gemma-4-12B-abliterated (Q6) |
| NVIDIA 12 GB | tier 1 | GLM-4-9B (Q6) |
| NVIDIA 8 GB | tier 0 | Qwen3.5-9B-abliterated (Q5) |

There are **five model tiers** (0 → 4), and under PoM **a GPU is bound to exactly one of them at a time**: it holds a single model's weights resident, and both mines that model's proof-of-work and answers that model's inference requests. It does **not** serve a range of smaller models — one card, one model. A larger card *may* choose to load a lower tier instead, but it then mines and earns at that lower tier; coverage of all five models across the network comes from *different* miners on different tiers, never from one card serving several. The highest tier a card can compete in is the largest model whose weights fit in its VRAM — from Qwen3-8B-abliterated (~4.6 GiB resident, tier 0) on a 6 GB card up to Kimi-Linear-48B in Q4 (~28 GiB resident, tier 4) on a 32 GB card. Architecture is not the gating factor: any NVIDIA GPU at SM 7.5+ (Turing onward) can run any tier its VRAM holds — the weights are read as quantized GGUF, so there is no higher floating-point compute floor. The heavier the tier, the larger the share of the block reward, through the tier-reward modifier (Section 6).

---

## 5. Proof-of-Model: Possession as Consensus

PoM is the layer that turns GPU mining into a measurable claim about AI capacity. It replaced the earlier optimistic-inference design, whose enforcement is described and retired in §8.2.

### 5.1 Design Principles

**Possession, not promises.** The scarce resource a miner must demonstrate is the model itself, resident in GPU memory. Nothing about this relies on the miner's honesty: the proof is re-verified byte-exactly by every node.

**One GPU, one tier.** The largest model a card can prove scales with its VRAM. A 48B tier cannot be faked by a card that cannot hold it, and holding it costs the miner real hardware.

**Enforce what is enforceable.** Possession and service are both decidable from data every node already holds, so both are enforced by consensus rather than by reputation or arbitration.

**Failure is priced, not trusted.** A miner who advertises a model and fails to serve it loses collateral and, on repetition, is suspended. No human arbitration, no reputation score.

### 5.2 The Possession Walk

Each mining attempt performs a data-dependent walk of **256 steps** (\`POM_WALK_STEPS\`). Every step reads 32 bytes whose address is derived from the previous step's state, so the read sequence cannot be predicted, precomputed, or replaced by a compact summary — the walk must touch the real weight file, in place, in VRAM.

The block header commits to the walk's final state:

\`\`\`
header.pom_final_state = fold64(walk_state[K])
\`\`\`

The block body carries a \`PomProof\` opening **32** (\`POM_OPENINGS\`) Fiat-Shamir-selected steps of the walk, each with its Merkle path to the model's tensor root. Verification re-walks the opened steps and checks:

1. Each opened read resolves to the pinned model root for the declared tier.
2. The recomputed final state equals \`header.pom_final_state\`.

A miner who does not hold the weights cannot answer the openings; a miner who holds a *different* model produces a root mismatch. Soundness scales as the fraction of honest steps raised to the number of openings.

The tensor root \`R_T\` is derived from the model file itself, so verification is byte-level: it is not a hash of a filename or a signed attestation, it is a statement about the bytes on the miner's card.

### 5.3 The Service Bond

Possession alone would let a miner hold weights and never answer anyone. The service bond closes that gap.

#### Bond creation

When a miner registers an \`escrow_pubkey\`, the node routes **20 % of the block subsidy** (\`COLLATERAL_RATE_BPS = 2000\`) to a CSV-locked output at index 1 of the coinbase:

\`\`\`
coinbase outputs:
  [fees]   → burn address       (100 % of transaction fees)
  [miner]  → miner payout SPK   (75 % of block subsidy)
  [bond]   → CSV-locked SPK     (20 % of block subsidy)
  [R&D]    → protocol treasury  (5 % of block subsidy)
\`\`\`

The relative timelock is **792,000 DAA (~22 h)**. Until it expires the output cannot be spent by anyone, the miner included. If no escrow pubkey is present, the 20 % is burned instead — a structural disadvantage for non-participating miners and pools.

#### Assignment and strikes

Requests are assigned to a cohort of miners that have proven the required tier within **3,000 DAA (~5 min)** of the assignment seed. Every cohort member gets at least **3,000 DAA (~5 min)** to see and serve the request.

A miner who is assigned a request and does not serve it takes a **strike**. Penalties escalate on *consecutive* strikes:

| Consecutive strike | Consequence |
|---|---|
| 1st | **5 escrow claims burned** (\`STRIKE_1_BURN_CLAIMS\`) |
| 2nd | **All still-locked escrow burned** (\`SlashAllPending\`) |
| 3rd | **24 h suspension** (\`SERVICE_SUSPENSION_DAA = 864,000\`), plus any escrow re-accumulated past the drain |

Two rules keep this from punishing ordinary operational trouble.

**At most one strike per hour.** Taking a strike makes a miner immune to further strikes for **36,000 DAA (~1 h)** (\`SERVICE_STRIKE_INTERVAL_DAA\`). Missing thirty requests during that hour costs exactly what missing one costs: a single strike.

This matters because the number of requests a miner is assigned is not under their control. Without the cap, a burst of traffic arriving while a rig reboots would spend all three strikes in seconds, and suspension would be a function of how busy the network happened to be rather than of the miner's conduct.

With the cap, the escalation is a clock rather than a counter: **a miner must refuse to serve for roughly three hours before suspension can apply.** Being offline still gets you there — but only if you stay offline.

**Serving resets the counter.** A single served assignment sets consecutive strikes back to zero (\`update_strikes\`). Penalties escalate only along an unbroken run of misses, so an honest miner's occasional miss never accumulates toward suspension no matter how many times it happens over the months.

A suspended miner's blocks remain **valid and merged** — they are simply paid nothing: the miner cut is burned for the duration. Rejecting a suspended producer's block would strand the honest miner who merged it, so the protocol punishes the payout, never the block.

Suspension is applied finality-deep, so it is immune to reorgs.

#### Identity and probation

Strikes, suspensions and standing follow the **payout address**, not the hot escrow key. A miner can rotate their escrow key freely — for operational reasons, or because it lives on a mining rig — without touching their record.

That leaves one obvious evasion: a miner carrying strikes simply mines to a fresh payout address and starts clean. Probation prices that move.

An identity is *in standing* only once it has been sighted at or before a lagged anchor **504,000 DAA (~14 h)** behind the current view. Until then it is on probation, and a probationary identity **earns the floor tier rate whatever tier it proves**:

| | Tier proven | Rate paid |
|---|---|---|
| In standing | 4 (48B) | 100 % |
| On probation | 4 (48B) | **60 %** — the tier-0 rate |

The rotation therefore costs up to **40 % of the miner cut for 14 hours**, on every block, regardless of the hardware behind it. Absorbing a strike is cheaper than starting over, which is exactly the ordering the protocol wants. Unpaid amounts are burned, not redistributed — nobody profits from someone else's probation.

The lag is not an arbitrary delay: it is finality plus the ledger horizon, so every event the evaluation reads is finality-flushed on every node long before any view that reads it. Standing is therefore a pure function of reorg-immune data — identical live, on catch-up, and on refold. A node re-deriving history from scratch computes the same probation status as one that watched it happen.

### 5.4 AI Transactions

Two transaction types identified by subnetwork ID, a multi-model registry enforced at the consensus level, and IPFS-based result storage. Enforcement was activated at **DAA 15,550,000**.

#### AiRequest (subnetwork 0x03)

\`\`\`
Binary payload layout (52 bytes minimum):
  [model_id:          32 bytes] — sha2-256 of the target model's primary weight file
  [max_tokens:         4 bytes LE] — maximum tokens to generate (cap: 4,096)
  [inference_reward:   8 bytes LE] — sompi paid to the miner who fulfils the request
  [priority_fee:       8 bytes LE] — sompi burned as network fee (min 0.3 KRX)
  [prompt:            variable] — UTF-8 encoded question
Max size: 4,096 bytes
\`\`\`

The transaction carries **two distinct economic flows**:

- **\`inference_reward\`** — held in \`output[1]\` as a CSV-locked escrow, paid to the miner who publishes the matching \`AiResponse\`. Consensus enforces per-model minimums plus a surcharge of **0.05 KRX per 64-token increment** of \`max_tokens\`.
- **\`priority_fee\`** — the standard UTXO fee, burned. Minimum 0.3 KRX.

**Per-model \`inference_reward\` minimums** (current uncensored lineup):

| Tier | Model | Minimum |
|---|---|---|
| 0 | Qwen3.5-9B-abliterated | 1.0 KRX |
| 1 | GLM-4-9B-0414 | 1.5 KRX |
| 2 | Gemma-4-12B-abliterated | 2.0 KRX |
| 3 | Qwen3.6-27B | 2.5 KRX |
| 4 | Kimi-Linear-48B | 4.0 KRX |

The effective minimum is \`base[model] + ⌈max_tokens / 64⌉ × 0.05 KRX\`. From the private-inference hardfork, the floor is fixed per model with no per-token surcharge, 0.5 KRX for tier 0 and 0.5 KRX more at each tier up to 2.5 KRX for tier 4, so a request costs its model's price plus the 0.3 KRX fee whatever its length, and \`max_tokens\` only bounds the response.

The \`model_id\` is the SHA-256 digest of the model's primary weight file — the same 32 bytes encoded in an IPFS CIDv0 multihash, and the same bytes the possession proof commits to. The on-chain request, the IPFS-hosted weights and the miner's proof therefore all name the identical artefact.

#### Capability Announcement

Miners declare their loaded models in every coinbase \`extra_data\`:

\`\`\`
/ai:cap:<model_id_hex64_1>,<model_id_hex64_2>,...
\`\`\`

A block carrying an \`AiResponse\` for a model absent from its own \`ai:cap:\` field is **rejected**. The announcement is what makes a miner eligible for assignment — and therefore what exposes them to strikes.

#### AiResponse (subnetwork 0x04)

The inference output is stored **off-chain on IPFS**; only a compact CID is committed:

\`\`\`
Binary payload layout (78 bytes, fixed):
  [request_hash:       32 bytes] — blake2b-256 of the AiRequest payload
  [escrow_window_end:   8 bytes LE] — blue score at which the request escrow unlocks
  [response_ipfs_cid:  34 bytes] — CIDv0 multihash: [0x12, 0x20, sha2-256_digest]
  [response_length:     4 bytes LE] — number of tokens generated
\`\`\`

Anyone can retrieve the full text through any IPFS gateway. The CID is a commitment to the exact bytes the user reads: once published, the answer is immutable and independently retrievable by anyone.

### 5.5 The Complete Flow

\`\`\`
[1] User        →  AiRequest tx                          →  Chain
                   (prompt + inference_reward escrow + priority_fee)
[2] Chain       →  block template (AiRequest visible)    →  Miner cohort
                   (eligibility = proven tier within ~5 min)
[3] Miner runs the model it has already proven it holds
[4] Miner uploads result to IPFS → obtains CIDv0
[5] Miner       →  AiResponse tx (IPFS CID)              →  Chain
[6] Chain       →  CID visible; user fetches from IPFS   →  User
[7] Request escrow unlocks to the miner
\`\`\`

If step 5 never comes, the assignment is a miss: the miner is struck, escrow claims burn, and a third strike suspends their payout for 24 h.

---

## 6. Economic Model

### 6.1 The KRX Coin

The native currency of Keryx is **KRX**. The smallest unit is the **sompi**:

\`\`\`
1 KRX = 100,000,000 sompi
\`\`\`

KRX serves three roles:
- **Mining reward** — compensation for PoW + inference work
- **Inference fee** — users pay 0.3 KRX per AiRequest (burned)
- **Service bond** — miners lock 20 % of every block subsidy as collateral against failing to serve

### 6.2 Emission Schedule

Keryx uses a smooth halving model: the block reward decays continuously using a monthly-granularity exponential function, with a 4-year halving period.

**Genesis parameters:**
- Initial emission rate: 5,400,000,000 sompi/second = 54 KRX/second
- Block reward at genesis (10 BPS): 540,000,000 sompi = **5.4 KRX/block**
- Halving period: 48 months (4 years)
- Genesis date: May 10, 2026

**Decay function:**
\`\`\`
reward_per_second(month m) = 5,400,000,000 × 2^(−m/48)  [sompi/s]
reward_per_block(month m)  = ceil(reward_per_second / 10)  [sompi]
\`\`\`

| Year | Block Reward | Annual Emission | Cumulative |
|------|-------------|-----------------|------------|
| 1 (2026) | ~5.4 KRX | ~1.66 B KRX | ~1.66 B KRX |
| 4 (2030) | ~2.7 KRX | ~830 M KRX | ~5.0 B KRX |
| 8 (2034) | ~1.35 KRX | ~415 M KRX | ~7.5 B KRX |
| 12 (2038) | ~0.675 KRX | ~207 M KRX | ~8.7 B KRX |
| 129 (2155) | ~0 KRX | tail only | ~9.9 B KRX |

**Maximum supply:** ~9,905,000,000 KRX (~9.9 billion)

**Tail emission:** After the main emission phase concludes (~2155), a permanent tail of 10 sompi/second (~0.00000001 KRX/s) maintains miner incentive indefinitely.

**Deflationary burn:** Transaction fees are burned in full, permanently reducing circulating supply below the theoretical maximum. At current network activity, ~9.4% of all mined KRX has been destroyed. If this burn rate holds over the full emission schedule, the effective long-term supply would converge toward ~9B KRX — approximately 10% below the theoretical maximum. Live burn figures are shown at the top of this page.

### 6.3 The Service Economic Loop

The 20 % bond turns availability into a priced commitment:

1. Miner locks 20 % of the block subsidy as a service bond, timelocked for 792,000 DAA (~22 h).
2. If they serve their assignments: the bond is recovered in a claim transaction whose fee is amortised across every matured output in the batch.
3. If they miss an assignment: the first strike burns 5 escrow claims; a third strike burns the miner cut outright for 24 h.
4. Users pay \`priority_fee\` (min 0.3 KRX, burned) + \`inference_reward\` (paid to the serving miner) per AiRequest.

The loop prices *availability*, which the protocol can measure, rather than *honesty*, which it cannot — see §8.2.

### 6.4 Fee Structure

| Transaction Type | Fee Model |
|---|---|
| Standard transfer | 0.3 KRX (burned) |
| AiRequest — \`priority_fee\` | min 0.3 KRX, burned as network fee |
| AiRequest — \`inference_reward\` | per-model minimum (1.0–4.0 KRX) + 0.05 KRX per 64 tokens until the private-inference hardfork, then a fixed price per model (0.5 KRX for tier 0, +0.5 KRX per tier, no surcharge); paid to the miner via CSV escrow in \`output[1]\` |
| Service bond claim | 0.3 KRX (burned) per claim transaction, not per block — one claim spends up to 80 matured escrow outputs at once, so the cost per reclaimed block is a fraction of a cent |

### 6.5 Reward Modifiers (PoM hardfork — DAA 37,780,000)

The PoM hardfork introduces two consensus-level modifiers that scale the miner's share of the block subsidy (the ~75% paid at \`output[0]\`). Both are **multiplicative**, and any amount not paid to the miner is **burned** — neither the escrow (20%) nor the R&D allocation (5%) is touched, so total emission only ever decreases. Both are computed by the node from on-chain state alone, so they require no miner input and cannot be gamed.

**Tier-reward.** The miner's cut is scaled by the PoM tier it actually proved for the block. Larger models — which require more VRAM and are more useful to the network — earn a larger share:

| Proven tier | Cut multiplier |
|---|---|
| 8B (Qwen3) | 68% |
| 7B (Mistral) | 76% |
| 9B (GLM-4) | 84% |
| 27B (Qwen3.6) | 92% |
| 48B (Kimi-Linear Q4) | 100% |

The tier is read from the verified PoM proof (\`proof.tier\`), not self-declared, so a miner cannot claim a higher tier than it possesses.

**Holder-reward.** The miner's cut is further scaled by how much KRX the payout address holds relative to its own recent production. The ratio is \`effective_balance ÷ windowed_production\`, where production is the miner's **gross** coinbase output over a sliding window of 864,000 blocks (~24 h): the base miner cut of every block the address produced (subsidy minus the R&D and escrow cuts), counted **before** the tier scaling and before the holder-bracket burn. The thresholds are expressed in **days of the miner's own production** — holding 90× your daily production reaches the top bracket. A miner that sells everything immediately sits at the floor; a miner that accumulates rises to 100%. This couples block rewards to a long position in the coin and rewards conviction over immediate liquidation, without any lock-up transaction or signature — the binding is automatic on the payout script.

The numerator is not the instantaneous balance but the **coin-age effective balance**: each UTXO contributes \`value × min(1, age/W)\` with \`W = 864,000\` blocks (~24 h), so a freshly received coin counts for nothing at first and ripens linearly to full weight over W. Age is bound to the payout script — sending coins to a different address resets it — so rotating a pot through fresh addresses no longer buys the top bracket. Consolidating UTXOs of mixed maturity anchors the merged output to its **youngest** input; consolidating coins of the same maturity class is free.

The schedule is nine brackets from a 50% floor to the full 100% cut. The ratio is compared by multiplication (\`effective_balance ≥ threshold × windowed_production\`), never division:

| Bracket | Condition (\`ratio = effective_balance ÷ windowed_production\`) | Held | Miner cut |
|---|---|---|---|
| 0 | \`ratio < 3\` | < 3 days of production — dumper | 50% |
| 1 | \`ratio ≥ 3\` | 3 days | 55% |
| 2 | \`ratio ≥ 7\` | 1 week | 60% |
| 3 | \`ratio ≥ 15\` | 2 weeks | 65% |
| 4 | \`ratio ≥ 30\` | 1 month | 70% |
| 5 | \`ratio ≥ 45\` | 6 weeks | 75% |
| 6 | \`ratio ≥ 60\` | 2 months | 80% |
| 7 | \`ratio ≥ 75\` | 2½ months | 90% |
| 8 | \`ratio ≥ 90\` | ~3 months in reserve | 100% |

\`windowed_production\` is the **gross** miner cut the payout address **produced over the last 24 h** (a rolling 864,000-block window): the base miner cut before the tier factor and before the bracket burn, so it is higher than what actually lands in the wallet. It has to be counted this way — it is the objective, pre-scaling amount every node derives identically, so the ratio can never diverge between nodes. It is a historical amount, counted whether or not the coins were later spent, so dumping recent rewards does not shrink it to game the ratio; and because it is gross, it must not be multiplied out to estimate income — the actual income is that amount times the tier factor and the bracket. It is floored at one block subsidy, so a fresh or zero-history address still needs \`effective_balance ≥ 90 × block_subsidy\` to reach bracket 8. Any shortfall below 100% is burned.

Because both modifiers co-activate at the hardfork, they compound: a small-tier, non-holding miner sits at the product of the two floors, while a top-tier miner holding well above the threshold earns the full 100% cut. The design favors operators who run large models *and* hold KRX — exactly the participants the network wants to retain. Reading the holder ratio from the **payout SPK** means pool participants are measured on the pool's aggregate balance and production, not their personal holdings; solo miners are measured on their own.

---

## 7. Network Architecture

### 7.1 Node (keryxd)

The Keryx full node is implemented in Rust, forked from [rusty-kaspa](https://github.com/kaspanet/rusty-kaspa). It maintains:

- The BlockDAG state (GHOSTDAG)
- The UTXO set (including escrow outputs)
- The AI transaction stores (AiRequest index, AiResponse index)
- The service-bond ledger (assignments, strikes, suspensions)

**Network ports:**

| Network | P2P | gRPC |
|---------|-----|------|
| Mainnet | 22111 | 22110 |
| Testnet-10 | 22211 | 22210 |
| Simnet | 22511 | 22510 |

**DNS seeder:** \`seed.keryx-labs.com\`

### 7.2 The Miner (keryx-miner)

The Keryx miner is a GPU-first application with three concurrent responsibilities:

1. **Proof-of-work** — PoM possession walk over the resident model weights, via CUDA
2. **Proof assembly** — Merkle openings for the walk, attached to the block body
3. **LLM inference** — open-weight GGUF models via an in-process inference engine

**Supported models:**

| Model | Flag | VRAM required | Format |
|---|---|---|---|
| Qwen3.5-9B-abliterated (uncensored) | \`--very-light\` | 8 GB | GGUF Q5_K_M |
| GLM-4-9B-0414 (uncensored) | \`--light\` | 12 GB | GGUF Q6_K |
| Gemma-4-12B-abliterated (uncensored) | *(default)* | 16 GB | GGUF Q6_K |
| Qwen3.6-27B (uncensored) | \`--high\` | 24 GB | GGUF Q4_K_M |
| Kimi-Linear-48B (uncensored) | \`--very-high\` | 32 GB | GGUF Q4_K_M |

Model weights are downloaded from IPFS on first launch using the Keryx gateway. The \`model_id\` in each \`AiRequest\` is the SHA-256 digest of the primary weight file — the same digest embedded in the IPFS CIDv0 for that file. The miner only processes requests whose \`model_id\` matches a model it has loaded. After the PoM hardfork the loaded weights serve double duty: they are both the inference engine and the scratchpad walked by the proof-of-work (Section 4.3).

The LLM engine runs on CUDA (compiled with CUDA 12.2 for broad driver compatibility — NVIDIA driver ≥ 535, SM 7.5+). Both PoM and inference go through the CUDA runtime and a custom CUDA kernel, so the reference miner requires an NVIDIA GPU. Mining and inference run concurrently on the GPU; the resident weights are shared between the PoM walk and inference so there is no second copy in VRAM.

After completing an inference, the miner uploads the result to its local IPFS node, obtains a CIDv0, and broadcasts an \`AiResponse\` transaction with the CID. The service-bond auto-claim module monitors mature block escrow outputs and broadcasts claim transactions when the CSV lock expires.

The miner declares its loaded models in every coinbase \`extra_data\` via the \`/ai:cap:\` field. After the hardfork activation, the node enforces that only declared models can appear in \`AiResponse\` transactions from that miner's blocks.

**Recommended hardware:** An NVIDIA GPU (SM 7.5+, driver ≥ 535) with sufficient VRAM for the chosen model tier. An 8 GB card handles Qwen3.5-9B-abliterated; a 12 GB card handles GLM-4-9B; a 16 GB card handles Gemma-4-12B-abliterated; a 24 GB card handles Qwen3.6-27B; a 32 GB card handles Kimi-Linear-48B (Q4). The larger the resident model, the higher the tier-reward multiplier (Section 6.5).

### 7.3 The API and Explorer

The off-chain infrastructure is deliberately decoupled from the node and zero-dependency on Kaspa's legacy stack:

**keryx-api** — A Rust/Axum service that:
- Indexes every block and transaction from the node's gRPC stream into PostgreSQL
- Exposes a RESTful API for the explorer, wallets, and exchanges
- Tracks AI transactions (request → response lifecycle)
- Monitors service-bond balances, strikes and suspensions

**keryx-ecosystem** — A Next.js 15 / React 19 frontend that provides:
- Real-time block and transaction feed (Server-Sent Events)
- AI inference feed (live view of AiRequest/AiResponse pairs)
- Address explorer with full transaction history
- Network statistics (hashrate, difficulty, emission, node distribution)
- Emission schedule visualization

---

## 8. Security Analysis

### 8.1 51% Attack Resistance

Keryx inherits GHOSTDAG's resistance to selfish mining: because the DAG accumulates all parallel blocks, a miner with less than 50% hashrate cannot systematically orphan honest miners' blocks. The high block rate (10 BPS) means that any attempt to build a private chain is quickly detected by the DAG's blue-score ordering.

### 8.2 Consensus-Level Guarantees

Three properties are established by consensus itself, re-derivable by every node from the block data alone. None of them depends on trusting the miner, an attestation service, or a committee.

- **Possession.** Every block carries a proof that the producing GPU held the declared model's weights, checked byte-exactly against the pinned tensor root. A miner cannot claim a tier their hardware cannot hold, and cannot substitute a smaller or different model — the walk resolves against the real file or it does not resolve at all.
- **Service.** A miner who advertises a model and then fails to answer an assignment is struck, burns escrow, and is suspended at the third consecutive strike. Enforcement is finality-deep and reorg-immune, so it reads identically on every node and survives any reorganisation of the DAG.
- **Integrity of the published answer.** The \`AiResponse\` commits to a CIDv0 of the output. Once published, the answer is immutable and independently retrievable by anyone through any IPFS gateway — the miner cannot revise it after the fact, and no gateway can serve different bytes under the same CID.

The practical consequence is that the network's inference capacity is a **lower bound readable from the chain** rather than a figure its operators assert. Every block names a specific model held by a specific GPU at a specific moment, and every unanswered assignment costs its miner real money.

### 8.3 Sybil Resistance

The service bond is tied to PoW: you cannot submit an \`AiResponse\` without first winning a block, which requires proving possession of the model on real hardware. Identity in the service cohort is therefore bought with GPUs and VRAM, not created for free — flooding the network with fake responder identities costs the same as flooding it with miners.

The subtler attack is not creating identities but *discarding* them. A miner who has accumulated strikes could mine to a fresh payout address and arrive with a clean record. Probation (§5.3) makes that unprofitable: a fresh identity earns the floor tier rate — 60 % instead of up to 100 % — for 504,000 DAA (~14 h), whatever tier its hardware proves. Rotating away from a strike costs more than the strike does, so the cheapest strategy is to keep one identity and serve.

Note what this does *not* rely on: no registration, no deposit beyond the bond, no KYC, and no global view of who owns which address. Two addresses run by the same operator are simply two identities, each paying its own probation.

### 8.4 P2P Attack Resistance

Keryx implements automatic peer banning for three attack patterns observed in the wild:

- **IBD spam**: peers that repeatedly trigger "peer has no known block" are banned for 24 hours on the first offense.
- **Finality violations**: peers whose pruning proofs conflict with the local finality point are banned immediately.
- **Phantom nodes**: peers that establish connections but never participate (detected via 3 ping timeouts in 10 minutes) are banned for 24 hours.

These protections, combined with a configurable inbound peer limit (256 on the current mainnet node), prevent slot exhaustion attacks.

---

## 9. Roadmap

### Phase 1 — Genesis (Completed)
- [x] Full Kaspa → Keryx rebrand (binary, ports, address prefix, genesis block)
- [x] KeryxHash (KERYX_MATRIX_SALT + wave_mix)
- [x] Inference commitment in every coinbase (format validation)
- [x] TinyLlama-1.1B inference in miner (candle-transformers)
- [x] Explorer + API (real-time, PostgreSQL indexed)
- [x] Richlist, top miners on explorer
- [x] Web wallet integration

### Phase 2 — Economy (Completed)
- [x] 20% escrow routing (CSV-locked, auto-claim in miner)
- [x] AiRequest / AiResponse transactions
- [x] P2P attack mitigations (autoban)
- [x] Escrow hard-lock: consensus-enforced relative timelock on the bond
- [x] Transaction fee burn (100% of fees destroyed)
- [x] Minimum transaction fee: 0.3 KRX

### Phase 3 — Multi-Model Oracle (Deployed — DAA 15,550,000)
- [x] Multi-model support: TinyLlama-1.1B, DeepSeek-R1-8B, DeepSeek-R1-32B, LLaMA-3.3-70B
- [x] Per-model \`inference_reward\` minimums enforced at consensus level
- [x] \`priority_fee\` separate from \`inference_reward\` (burned vs miner-paid)
- [x] Token-count surcharge (0.05 KRX per 64-token increment), replaced by fixed per-model rewards (0.5 to 2.5 KRX) at the private-inference hardfork
- [x] Model capability announcement in coinbase extra_data (\`/ai:cap:\`)
- [x] Consensus enforcement: AiResponse rejected if model not declared in caps
- [x] IPFS result storage: AiResponse stores CIDv0 instead of inline text
- [x] model_id = SHA-256(weight file) = IPFS CIDv0 content hash
- [x] IPFS for model weight distribution (miner downloads from Keryx IPFS gateway)
- [x] CUDA inference support (candle-core, VRAM-aware multi-model placement)

### Phase 4 — Proof-of-Model & Holder Economics (Deployed — DAA 37,780,000)
- [x] PoM: KeryxHash matrix-multiply replaced by a data-dependent walk over the resident model weights (possession proof, one GPU = one tier)
- [x] Byte-exact deterministic verification via per-tier weight Merkle root \`R_T\` + Fiat-Shamir chunk openings (pool-safe, fork-proof)
- [x] Zero-copy: PoM walk shares the inference weights resident in VRAM (no second copy)
- [x] Uncensored five-tier lineup: Qwen3-1.7B, Gemma-3-4B, Dolphin-3.0-8B, Qwen3-32B, LLaMA-3.3-70B (Q2)
- [x] Tier-reward: miner cut scaled by proven PoM tier (68/76/84/92/100%), delta burned
- [x] Holder-reward: miner cut scaled by KRX held relative to windowed production, delta burned
- [x] CUDA mining engine (PoM walk + inference on a custom CUDA kernel)
- [x] Walk v2 (H5 — DAA 59,009,037): non-foldable chained transition closes the partial-copy shortcut; parallel-block cap (N=20); tier-0 raised to Qwen3-8B-abliterated (6 GB floor)

### Phase 5 — Scaling & Sovereign Intelligence *(Research)*
- [ ] Reproducible inference (integer-only execution): deterministic, bit-identical generation across heterogeneous GPUs — the foundation any future output-level guarantee would build on
- [ ] **The network is the model**: split a large model into shards served by several miners, each holding one slice resident in VRAM, so the network as a whole serves models no single card can hold — the first experiment measures per-token latency across miners on a small model before scaling up
- [ ] Stateful models with persistent memory: retrieval-augmented memory over past inferences, so a request can build on earlier answers
- [ ] Tool and network access: models allowed to call external tools and fetch live data during generation
- [ ] Private inference: the prompt sealed to the serving miners' keys and the answer sealed back to the requester, so only the two parties can read them — the chain keeps the metadata (model, fee, responders) and nothing else

### Phase 6 — The Cross-Chain Oracle
- [ ] Ethereum bridge: smart contract → AiRequest → Keryx → result → Ethereum callback
- [ ] Solana bridge (same pattern)
- [ ] On-chain agent demo: autonomous Ethereum agent calling Keryx for decisions
- [ ] Model query API: submit a request and read its answer programmatically, so agents and applications can use Keryx models without running a node

Bridges ship last, once the inference layer is feature-complete: a cross-chain oracle is only useful when there is a rich, scalable inference network behind it to call.

---

## 10. Conclusion

Keryx demonstrates that proof-of-work and useful AI capacity are not mutually exclusive. By making the model weights the working set of the proof-of-work itself, the protocol turns mining hardware into a permissionless, censorship-resistant inference network whose capacity is measurable from the chain rather than asserted by its operators.

The guarantees are narrow by design and therefore real: possession is proven byte-exactly by every node, service is priced in burned collateral, and the published answer is immutable. Each one is re-derivable from the chain by anyone, with no trusted party anywhere in the path.

Keryx is not a smart contract platform with an AI plugin. The inference is the consensus. The miners are the models. The chain is the oracle.

---

## Appendix A — Key Constants

| Constant | Value |
|---|---|
| 1 KRX | 100,000,000 sompi |
| Max supply | ~9,905,000,000 KRX |
| Genesis block reward | 5.4 KRX |
| Halving period | 48 months |
| Tail emission | 10 sompi/second |
| BPS | 10 |
| GHOSTDAG k | 124 |
| Merge depth | 36,000 blocks |
| Finality depth | 432,000 blocks |
| Service bond | 20% of block subsidy |
| Service bond timelock | 792,000 blocks (~22 h) |
| Legacy escrow window (pre-H6) | 36,000 blocks (~1 hour) |
| Service suspension (3rd strike) | 864,000 blocks (~24 h) |
| Min tx fee | 0.3 KRX |
| Mainnet P2P port | 22111 |
| Mainnet RPC port | 22110 |
| Genesis date | May 10, 2026 |
| Phase 3 activation DAA | 15,550,000 |
| SALT v2 activation DAA | 17,275,000 |
| PoM hardfork DAA | 37,780,000 (2026-06-26 18:00 UTC) |
| H5 hardfork DAA (walk v2, parallel cap, tier-0 swap) | 59,009,037 (2026-07-25) |
| Tier-reward multipliers | 60% / 70% / 80% / 90% / 100% (9B / 9B / 12B / 27B / 48B) |
| Holder-reward production window | 864,000 blocks (~24 h) |
| Min NVIDIA compute cap | SM 7.5 (GTX 1660 / RTX 2060) |
| CUDA version | 12.2 (driver ≥ 535) |

## Appendix B — wave_mix Reference Implementation (C)

\`\`\`c
#define ROUNDS 4
static const uint64_t KEYS[4] = {
    0x9e3779b97f4a7c15ULL,
    0x6c62272e07bb0142ULL,
    0xb5ad4eceda1ce2a9ULL,
    0x243f6a8885a308d3ULL,
};
static const uint32_t ROTL_AMOUNTS[4] = {17, 31, 47, 13};

static inline uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

void wave_mix(uint8_t bytes[32]) {
    uint64_t w[4];
    for (int i = 0; i < 4; i++)
        memcpy(&w[i], bytes + 8 * i, 8);
    for (int r = 0; r < ROUNDS; r++) {
        w[0] = rotl64(w[0] + w[1], ROTL_AMOUNTS[0]) ^ KEYS[r % 4];
        w[2] = rotl64(w[2] + w[3], ROTL_AMOUNTS[2]) ^ KEYS[(r + 2) % 4];
        w[1] = rotl64(w[1] + w[2], ROTL_AMOUNTS[1]) ^ KEYS[(r + 1) % 4];
        w[3] = rotl64(w[3] + w[0], ROTL_AMOUNTS[3]) ^ KEYS[(r + 3) % 4];
    }
    for (int i = 0; i < 4; i++)
        memcpy(bytes + 8 * i, &w[i], 8);
}
\`\`\`

## Appendix C — AI Transaction Payload Binary Formats

### AiRequest (subnetwork 0x03)

\`\`\`
Offset  Size  Type    Field
------  ----  ------  -----
0       32    bytes   model_id — SHA-256(primary weight file) = CIDv0[2..34]
32       4    u32 LE  max_tokens
36       8    u64 LE  inference_reward (sompi) — paid to miner via output[1] escrow
44       8    u64 LE  priority_fee (sompi) — burned as network fee (min 0.3 KRX)
52      var   UTF-8   prompt

Min size: 52 bytes
Max size: 4,096 bytes
\`\`\`

The AiRequest transaction must include \`output[1]\`: a CSV-locked P2PK script with value ≥ \`inference_reward\`.

### AiResponse (subnetwork 0x04)

\`\`\`
Offset  Size  Type    Field
------  ----  ------  -----
0       32    bytes   request_hash — blake2b-256 of the AiRequest payload
32       8    u64 LE  challenge_window_end — blue score when window closes
40      34    bytes   response_ipfs_cid — CIDv0: [0x12, 0x20, sha2-256_digest]
74       4    u32 LE  response_length — tokens generated

Fixed size: 78 bytes
\`\`\`

The full inference result is stored on IPFS. The on-chain CID is the SHA-256 of the content prefixed with \`[0x12, 0x20]\` — standard IPFS multihash format (CIDv0).

## Appendix D — Mining Pool Integration

Mining pools present a structural consideration: the pool server constructs the block template and controls the coinbase \`extra_data\`, while the proof of work — and, under PoM, the model possession it proves — happens on the workers' GPUs.

**Pool-aware bonding:** Pools that register an \`escrow_pubkey\` post the service bond and recover the 20% cut. Workers receive their proportional share of pool earnings.

**Standard pools:** Pools that do not register an \`escrow_pubkey\` produce fully valid blocks but their 20% bond allocation is burned. This creates a natural incentive for pools to post the bond: non-participating pools are at a 20% structural disadvantage versus OPoI-enabled competitors.

**Where inference runs.** Inference runs on the workers' GPUs, not on pool infrastructure. This follows directly from PoM: every worker already proves byte-exact possession of its tier model on every share it submits, so the machines holding the weights are precisely the machines that should answer requests. The pool's role is dispatch and on-chain settlement:

1. the pool selects a pending \`AiRequest\` and dispatches it to a worker that declared the corresponding model;
2. the worker runs the inference and returns the raw result asynchronously;
3. the pool pins the result to IPFS and broadcasts the \`AiResponse\`;
4. the pool owns the escrow — it claims after maturity and credits the worker internally.

The pool pins the IPFS result itself rather than delegating that to the worker, because it is the pool's escrow that stands behind the response during the challenge window: result availability belongs with whoever carries the risk. Workers never hold escrow keys.

### Pool protocol contract

**Share submission.** A PoM share cannot be verified without its possession proof, so every paid share carries the complete proof:

\`\`\`
mining.submit = [worker, job_id, nonce_hex16, opoi_tag_hex16, cid_or_empty, pom_proof_hex]
\`\`\`

\`pom_proof_hex\` is the hex encoding of the canonical borsh wire form of the \`PomProof\` the node consumes. The pool must forward those exact bytes into \`block.pom_proof\` and set \`header.pom_final_state\` to the proof's \`final_state\` before submitting the block — never re-serialize the structure. Parameters 4 and 5 (\`opoi_tag\`, \`cid\`) are vestiges of the pre-PoM OPoI era and carry no consensus meaning; accept them for backward compatibility with existing miners.

A share is valid when \`pom_pow_value(final_state, pre_pow_hash) <= share_target\`, and \`final_state\` is only trustworthy once the proof's 256 walk steps have been replayed against the tier's pinned Merkle root. There is no lighter share format — proving possession on every share is the entire point of PoM. The proof is structurally bounded rather than open-ended: 256 steps, each carrying a 32-byte chunk and one Merkle path, which comes to roughly 250 KB borsh (500 KB hex) on the deepest tier. The maximum accepted frame is 2 MB per JSON-RPC line.

Verification is era-exact: seed derivation and the walk transition are DAA-gated. Pools should vendor the node's \`pom\` module rather than reimplement it from prose.

**Inference dispatch.** Results travel on a dedicated \`mining.ai_response\` message rather than being attached to the next share submission.

**Capability declaration.** The coinbase \`ai:cap\` field declares the union of the models the pool's workers actually serve. Its consensus role is narrow and specific: an \`AiResponse\` included in a block must reference a \`model_id\` declared in that same block's coinbase, so a pool must pair request and response within one block. It has no bearing on the tier reward, which is derived exclusively from the PoM proof — a block won on a top-tier proof may carry responses for any model the pool serves.

### Pool implementation guide

This section provides the concrete technical details required for mining pool operators to integrate the service bond.

**Step 1 — Embed the escrow public key in coinbase extra_data**

There is no node-level configuration for the escrow key. The pool controls the coinbase \`extra_data\` and must embed the escrow public key directly using the protocol marker:

\`\`\`
extra_data format: /{nonce_hex16}/ai:v1:{tag_hex16}/escrow:{64-hex-chars-of-32-byte-schnorr-pubkey}
\`\`\`

The node scans every coinbase \`extra_data\` for the \`/escrow:\` marker followed by exactly 64 hex characters. If found and valid, the escrow output is automatically created. If absent or malformed, the 20% escrow cut is sent to the burn address instead.

**Step 2 — Coinbase output structure**

Here is the breakdown for a **5.4 KRX block reward**:

- **75% (4.05 KRX)** — Sent immediately to the payout address. This is the base on which the tier and holder multipliers are applied; whatever they scale away is burned.
- **20% (1.08 KRX)** — Escrow, recovered after maturity. Claiming costs a flat 0.3 KRX per transaction regardless of size, and one claim spends many matured outputs at once, so the effective per-block cost is that fee divided across the batch — under 0.004 KRX at a batch of 80.
- **5% (0.27 KRX)** — Allocated to R&D (protocol treasury).

Note that the escrow and R&D cuts are computed on the full subsidy: the tier and holder multipliers scale the miner cut alone.

The escrow output locking script is:

\`\`\`
<36000> OP_CSV <escrow_pubkey_32bytes> OP_CHECKSIG
\`\`\`

Note: Keryx's \`OP_CSV\` pops its argument from the stack — no \`OP_DROP\` is needed.

**Step 3 — Track mature escrow outputs**

An escrow output becomes spendable once \`current_daa_score >= utxo.block_daa_score + 36000\`. The condition is evaluated on the **DAA score**, not the blue score, and the spending input must carry \`sequence = 36000\`.

\`GetUtxosByAddresses\` cannot serve this purpose: it derives a standard pay-to-address script from the address it is given and therefore never matches the CSV escrow script. Two approaches work instead.

*Live tracking (recommended).* Subscribe to \`VirtualChainChanged\` and fetch each new chain block, scanning its coinbase outputs for the pool's escrow script. **Only chain-block coinbases matter.** Every block's coinbase pays the blues of its own mergeset, but off the selected chain those outputs never enter the UTXO set — tracking escrow from every block seen therefore produces phantom outpoints whose claims can only ever be rejected as orphans.

*Cold-start recovery.* The keryx-api REST endpoint lists escrow outputs for a pubkey:

\`\`\`
GET /api/v1/escrow/{escrow_pubkey_hex}
\`\`\`

This index is advisory and deliberately slightly over-inclusive; the node remains the sole arbiter of whether an output is still unspent.

**Step 4 — Broadcast claim transactions**

A claim transaction spends matured escrow outputs back to any pool address:

\`\`\`
inputs:  N matured escrow UTXOs (each signed with escrow_privkey, sequence = 36000)
output:  pool payout address (total input value minus the flat claim fee)
\`\`\`

Any number of matured outputs may be spent by a single transaction, bounded only by the standard transaction mass limit: compute mass is \`506 + 1118 x inputs\` grams against a 100,000-gram cap, making 88 inputs the hard ceiling. Since the claim fee is flat per transaction rather than per output, batching is the difference between paying that fee once per block found and once per batch. The reference miner batches up to 80 outputs, submitting a partial batch only when the oldest matured output has waited 24 hours.

### Pool accounting

**Tier-weighted shares.** The cost of a hash does not depend on the tier — the walk is always 256 reads — but the revenue of a block does, since the miner cut is scaled by the tier of the winning proof. A share's expected contribution is therefore proportional to its own tier multiplier (68% / 76% / 84% / 92% / 100%), and shares should be weighted by the tier of the proof they carry rather than counted equally. Counting them equally would have small-tier workers subsidised by large-tier ones.

**Holder multiplier.** The holder ratio is read from the payout SPK, so in a pool it is a single pool-wide revenue factor: the pool's aggregate balance measured against its own windowed production. No per-worker attribution exists at consensus level, so the multiplier is necessarily socialised across all shares, and the pool's treasury policy determines the bracket everyone earns at.

**Escrow crediting.** The 20% escrow is revenue from the same block, merely deferred by the maturity window and one claim transaction. It is neither tier- nor ratio-scaled, so its amount is exactly 20% of the blue's subsidy and can be credited at block time or at claim time without ambiguity.

**Inference rewards.** The \`inference_reward\` reaches the pool through the escrow output of the \`AiRequest\` itself. Distribution is not dictated by the protocol, but it should follow the GPU that did the work: inference is discrete piecework with no variance, so spreading it across a share window smooths nothing and merely decouples the reward from the machine that earned it.

---

*Keryx is open source (MIT License). Source code: github.com/Keryx-Labs*
`;
