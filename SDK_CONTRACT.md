# Keryx wallet — WASM SDK contract (verified, do not invent)

The GUI reuses the **audited Keryx wallet-core** compiled to WASM (`src/sdk/kaspa.{js,d.ts}` + `kaspa_bg.wasm`).
All snippets below are verified against `src/sdk/kaspa.d.ts` (cited `kaspa.d.ts:N`) and the official
examples in `keryx-node/wasm/examples/`. Build recipe at the bottom.

## Network / address prefix
- `NetworkType { Mainnet=0, Testnet=1, Devnet=2, Simnet=3 }` (kaspa.d.ts:417); `NetworkId` (5689) `.addressPrefix()`.
- SDK takes network **strings**: `"mainnet"`, `"testnet-11"`, `"simnet"` (init.js:32 regex).
- ⚠️ The `.d.ts` doc-comments show upstream `kaspa:` prefix; the **real prefix is produced at runtime** by the
  Keryx build. **MUST verify at app startup**: `new kaspa.PrivateKey(<hex>).toAddress("mainnet").toString()` →
  expect it to start with `keryx:`. Assert/log this on boot. Coin type: `m/44'/111111'/0'/0` (init.js:94).

## Init (Vite, target=web)
```ts
import * as kaspa from "./sdk/kaspa.js";
import wasmUrl from "./sdk/kaspa_bg.wasm?url";
await kaspa.default(wasmUrl);          // top-level await in an async init
// kaspa.initConsolePanicHook();       // dev only
```

## Connect to the user's node (wRPC, no public resolver)
Keryx Borsh wRPC = **:23110** (JSON :24110). Connect over WebSocket.
```ts
const rpc = new kaspa.RpcClient({ url:"ws://127.0.0.1:23110", encoding:kaspa.Encoding.Borsh, networkId:"mainnet" });
await rpc.connect();                                   // kaspa.d.ts:6758
const { isSynced, virtualDaaScore } = await rpc.getServerInfo();
```

## Wallet (class `Wallet`, kaspa.d.ts:7519) — storage is INTERNAL (localStorage+IndexedDB, Argon2+XChaCha20)
```ts
const wallet = new kaspa.Wallet({ resident:false, networkId:"mainnet", url:"ws://127.0.0.1:23110" }); // IWalletConfig 4107
// CREATE (show the mnemonic for backup BEFORE persisting):
const m = kaspa.Mnemonic.random(24);                   // kaspa.d.ts:5654 — show m.phrase to user
await wallet.walletCreate({ walletSecret, filename:"main", title:"Main" });   // 7558
const pk = await wallet.prvKeyDataCreate({ walletSecret, mnemonic:m.phrase }); // 7658
await wallet.accountsCreate({ walletSecret, type:"bip32", accountName:"Account 1", prvKeyDataId:pk.prvKeyDataId }); // 7583
// IMPORT existing phrase: same prvKeyDataCreate({mnemonic}) + accountsCreate (NOT walletImport — that takes an encrypted blob).
// OPEN / UNLOCK:
const { accountDescriptors } = await wallet.walletOpen({ walletSecret, filename:"main", accountDescriptors:true }); // 7538
await wallet.accountsActivate({ accountIds:[accountDescriptors[0].accountId] }); // 7608
await wallet.connect(); await wallet.start();          // 7750 / 7745
await wallet.exists("main");                            // 7749 — gate onboarding vs unlock
```

## Receive
```ts
const addr = acc.receiveAddress.toString();             // from IAccountDescriptor (kaspa.d.ts:3726)
// new address: wallet.accountsCreateNewAddress({ accountId, addressKind:kaspa.NewAddressKind.Receive }) // 7718
```

## Balance — via EVENTS (no sync getter)
```ts
wallet.addEventListener(({type,data}) => {
  if (type==="balance") { /* data.balance.mature, data.balance.pending (sompi, bigint) */ }  // IBalanceEvent 4464
});
```

## Send (+ estimate)
```ts
const est = await wallet.accountsEstimate({ accountId, destination:[{address,amount}], priorityFeeSompi }); // 7613 → GeneratorSummary
const r   = await wallet.accountsSend({ accountId, walletSecret,
            priorityFeeSompi: kaspa.kaspaToSompi("0.001"),
            destination:[{ address:destAddr, amount:kaspa.kaspaToSompi("1.5") }] }); // 7553 → { transactionIds[] }
const rate = await wallet.feeRateEstimate();            // 7623
```
Amounts are **sompi** (bigint); `kaspaToSompi` / `sompiToKaspaString` for conversion. (1 KRX = 1e8 sompi.)

## History / activity
```ts
const { transactions } = await wallet.transactionsDataGet({ accountId, networkId:"mainnet", start:0, end:50 }); // 7673
// tx.id, tx.data.type (TransactionDataType 3754: incoming/outgoing/...), tx.data.data.value
```

## Events to subscribe (wallet.addEventListener)
`connect, disconnect, sync-state, balance, pending, maturity, discovery, reorg, daa-score-change, server-status, account-activation, error` (UtxoProcessorEventType 4476 + Wallet additions).

## Security model
- SDK encrypts the seed (Argon2 → XChaCha20-Poly1305) and persists in the webview's localStorage/IndexedDB
  (under Tauri's app data dir). We never store the seed plaintext and never log secrets.
- The Argon2 salt is deterministic (= SHA256(password), upstream); acceptable for a local desktop app.
  Hardening options (later): OS keychain for an extra wrapping key; strong-password enforcement; auto-lock.
- Tauri: strict CSP, no remote content, `dangerousRemoteDomainIpcAccess` off; `?url` for the local wasm.

## SDK build recipe (to regenerate from a new keryx-node release)
```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
# clang is required (secp256k1-sys → wasm). If only clang-NN exists, symlink it onto PATH:
#   ln -s /usr/bin/clang-16 ~/.local/wasmbin/clang ; ln -s /usr/bin/llvm-ar-16 ~/.local/wasmbin/llvm-ar
#   export PATH=~/.local/wasmbin:$PATH CC=clang AR=llvm-ar
cp keryx-node/Cargo.lock keryx-node/wasm/Cargo.lock     # pins a yanked transitive dep (serde_nested_with)
cd keryx-node/wasm && ./build-web --sdk                  # → web/kaspa/{kaspa.js,kaspa.d.ts,kaspa_bg.wasm}
# copy web/kaspa/* into this project's src/sdk/
```
