# Testing the Keryx Wallet on the node box

The wallet is a **light wallet**: it has no embedded node and syncs nothing itself — it talks to a
Keryx node's wRPC. Easiest test setup: run the wallet **on the same Linux machine as `keryxd`**.

## Prerequisites
- `keryxd` running **with `--utxoindex`** and synced, exposing wRPC Borsh on `127.0.0.1:23110`
  (the default `--rpclisten-borsh=default`). The wallet's default node URL is `ws://127.0.0.1:23110`.
  - To use the wallet from a **different machine**, restart the node with
    `--rpclisten-borsh=0.0.0.0:23110` and set the wallet node URL to `ws://<node-LAN-ip>:23110`.

## Install / run
```bash
# Option A — install the built package:
sudo dpkg -i "src-tauri/target/release/bundle/deb/Keryx Wallet_0.1.0_amd64.deb" || sudo apt-get -f install
keryx-wallet            # launch from menu or this command

# Option B — run from source (dev):
npm install && npm run tauri dev
```

## Happy-path test
1. **Create** → write down the 24-word phrase → confirm the 2 requested words → set a password (≥8).
2. Open **Node settings** (top-right). Confirm URL `ws://127.0.0.1:23110`, network `mainnet`, Save.
   - The banner should go **connected** and then **synced** (it reflects the node's sync state).
3. **Receive** → copy your address (QR shown). It must start with **`keryx:`** ← verify this.
4. From a miner (or any funded wallet), **send some KRX** to that address.
   - The dashboard **balance** (mature/pending) and **activity** list should update within seconds.
5. **Send** → paste a destination, amount → *Estimate fee* → review → password → confirm → you get txid(s).
   The activity list should show the outgoing tx.
6. **Settings → Recovery phrase**: reveal it (re-enter password) — must match what you wrote down.
7. **Settings → Export encrypted wallet** → saves `keryx-wallet-backup.txt`.
   **Settings → Change password** → change it, then lock + unlock with the new one.
8. **Restore round-trip**: on a fresh machine/profile, either **Import recovery phrase** (the 24 words)
   or **Restore from wallet file** (the exported `.txt` + the password it was exported with).

## What to confirm at runtime (verified-defensive, not yet seen against a live node)
- Address prefix is **`keryx:`** (the bundled SDK is the Keryx build; logged on boot as
  `[wallet] address prefix verified: keryx`). If it logs something else, tell me.
- **Balance / activity** arrive via SDK events; if the balance shows 0 after funding, the event field
  shape may differ from what we handled defensively — note the exact behavior and we'll align it.
- **Send** signs with `accountsSend`; the fee shown at confirm is the one signed (amounts are frozen).

## Troubleshooting
- **"Not connected"** → node URL wrong, node down, or wRPC bound to loopback while the wallet is on
  another machine (see Prerequisites).
- **"Node is not synced"** → wait until `keryxd` is synced; sending is blocked until then.
- **Balance stuck at 0 / no history** → confirm the node has `--utxoindex` (the SDK needs it).
- Logs: run via `npm run tauri dev` to see the console (address-prefix + connection logs). No secrets
  are ever logged.
