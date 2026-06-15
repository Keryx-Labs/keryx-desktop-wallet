# Keryx Wallet — QA / Test Plan (V21)

Light wallet; talks to a Keryx node's wRPC. **All money tests must be run against a real, synced node**
(via the SSH tunnel so the wallet's default `ws://127.0.0.1:23110` reaches the node). Use small amounts.

Legend: ⬜ = to run, note PASS/FAIL + what you saw.

---

## 0. Setup
- ⬜ Open the SSH tunnel from the Windows box to the node, then launch `keryx-wallet-portable-V21.exe`.
- ⬜ Node settings (gear): URL `ws://127.0.0.1:23110`, network `mainnet`, Save → banner goes **connected → synced**.
- ⬜ Boot log shows `address prefix verified: keryx` (run via `npm run tauri dev` if you want the console; the portable has no console).

## 1. New fixes in V21 (the point of this build)
**A5 — send is blocked on an un-synced node**
- ⬜ With the node still syncing (or right after connect, before "synced"), try **Send** → must refuse with
  *"Connect to a synced node first."* and NOT build/sign anything. (Consolidate already did this; now send matches.)

**A2 — largest-UTXO-first selection**
- ⬜ On a wallet with several UTXOs, do a normal small send → succeeds. (Regression-safe; ordering is internal.)
- ⬜ If you can arrange a wallet whose balance is spread across many UTXOs, send an amount that a few large
  UTXOs cover → it should fund from the **largest** ones and succeed (previously could falsely fail).

**A1 — honest message when funds span >80 UTXOs**
- ⬜ Only reproducible with >80 UTXOs. Try to send an amount larger than the 80 largest UTXOs combined →
  message must say *"This amount needs more than 80 UTXOs in one transaction. Consolidate your funds first, then send."*
  (NOT the old misleading "Amount exceeds your spendable balance"). Then **Consolidate**, then retry the send → succeeds.
- ⬜ Sanity: on a normal wallet, trying to send MORE than you own still says *"Amount exceeds your spendable balance."*

## 2. Core money flows (regressions — must still work exactly like V20)
- ⬜ **Consolidate** a wallet with ≥2 UTXOs → returns txid(s); after maturity the UTXO count drops. (This is the V20-proven path.)
- ⬜ **Send** to a second address you control → txid returned; recipient balance rises; sender drops by amount+fee.
- ⬜ **Estimate fee** before a send shows a fee ≥ 0.3 KRX (the KERYX_MIN_FEE floor) and the confirmed fee matches.
- ⬜ **Receive** → address starts with `keryx:`; QR scans to that exact address. Generate a **new** receive address,
  send to it, confirm the balance still updates (RPC-fallback balance covers all account addresses).
- ⬜ **Activity/history** lists the incoming and outgoing txs.

## 3. Onboarding / key management (no money, but security-critical)
- ⬜ **Create** → 24 words shown → confirm the 2 challenge words → set password (≥8). Write the phrase down.
- ⬜ **Settings → Recovery phrase**: reveal (re-enter password) → matches what you wrote.
- ⬜ **Export encrypted wallet** → saves the `.txt`. **Change password** → lock → unlock with the NEW password.
- ⬜ **Restore round-trip** on a fresh profile (rename/clear `KeryxWalletData/`): Import the 24 words → same address +
  balance appear. Also test **Restore from wallet file** (the exported `.txt` + its password).
- ⬜ Wrong password on unlock → clear error, no crash, no lockout of the file.

## 4. Validation / safety guards (try to make it misbehave)
- ⬜ Send to an **invalid address** (typo, truncated) → rejected *before* signing.
- ⬜ Send to a **testnet/other-network** address while on mainnet → rejected (network-prefix check).
- ⬜ Send **0** or a negative/garbage amount → rejected.
- ⬜ Send an amount equal to full balance (no room for fee) → rejected with *"Amount + network fee exceeds your balance."*
- ⬜ **Double-submit**: on the confirm screen, click "Confirm & send" fast/twice → must NOT broadcast two txs
  (only one txid; the second click is ignored or errors). *(Known narrow window — flag if you ever see 2 txids.)*
- ⬜ **Auto-lock**: leave the app idle → it locks; unlock works.

## 5. Chain-safety / "don't break or get hacked" checks
- ⬜ **What you confirm is what's signed**: the amount + fee on the confirm screen equals the broadcast tx
  (check on a Keryx explorer / node). Amounts are frozen at confirm.
- ⬜ **No double-spend on retry**: if a send shows `[submit] timeout` but you suspect it landed, check history/explorer
  BEFORE retrying. A retry over already-spent inputs must fail cleanly (node rejects), not create a second payment.
- ⬜ **No secret leakage**: nothing in any visible error/log shows the seed, password, or private keys. (The handoff
  contract forbids logging secrets; confirm visually on every error you hit.)
- ⬜ **Offline/loss-of-node**: kill the tunnel mid-session → app shows "Not connected", does not crash, does not send.
- ⬜ The wallet **cannot affect consensus**: it only submits standard signed txs via RPC. Confirm the node accepts/rejects
  them normally; the wallet has no other node control surface.

## 6. After all green
- ⬜ Keep V20 as the rollback. If V21 passes 1–5, it becomes the new GOOD build.
- ⬜ Then proceed to the GitHub prep (delete `WALLET_DEBUG_HANDOFF.md`, scrub node IP, extend `.gitignore`,
  rotate any token) and push to a `keryxpool/*` branch for the dev — NEVER `main`.

---
### Notes column
Record for each ⬜: txid(s), exact error text, and anything unexpected. A failure in section 1 blocks release;
a failure in 2/3/5 is a regression and blocks; 4 is hardening (note + we fix in a follow-up).
