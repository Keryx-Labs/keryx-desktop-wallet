# Keryx Wallet

A lightweight, self-custodial desktop wallet for the **Keryx** network, available for **macOS**, **Linux**, and **Windows**.

Your keys never leave your device. The recovery phrase is encrypted at rest, and every spend is confirmed and signed locally — the wallet only talks to a Keryx node to read balances and broadcast transactions.

<p align="center">
  <img src="docs/screenshots/welcome.png" alt="Keryx Wallet — welcome screen" width="640">
</p>

## Download

Prebuilt binaries are attached to each [GitHub Release](../../releases):

- **macOS:** `.dmg` (drag to Applications) or the `.app` bundle. A single **universal** build runs natively on both Apple Silicon and Intel Macs.
- **Windows:** `.msi` or `.exe` installer, or the standalone **portable** `.exe` (no install — just run it).
- **Linux:** `.deb` or `.AppImage`.

> **macOS note:** the release is currently **unsigned**. On first launch Gatekeeper will warn that the app is from an unidentified developer — right-click the app → **Open** → **Open** to run it. (The release workflow is wired for Apple code signing + notarization via `APPLE_*` repository secrets, so a maintainer with an Apple Developer ID can enable a signed build without code changes.)

## Features

- **Create or import** a wallet from a 24-word recovery phrase, with on-screen backup confirmation.
- **Password unlock** with automatic lock on inactivity.
- **Dashboard** showing mature and pending balance alongside transaction history.
- **Send** with address and network validation, fee estimation, and an explicit confirmation step.
- **Receive** with a copyable address and QR code.
- **Configurable node endpoint** (wRPC), so you can point the wallet at your own node.

## Requirements

- A reachable Keryx node wRPC (Borsh) endpoint — default `ws://127.0.0.1:23110` — started with `--utxoindex`.
- For development: Node 20+ and Rust (stable). Plus the per-OS Tauri dependencies:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`). To build a universal `.dmg`, add both Rust targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
  - **Linux:** `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.
  - **Windows:** the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 10/11).

## Getting started (development)

```bash
npm install
npm run tauri dev      # launches the app against your configured node
```

## Building installers

### macOS (local)

```bash
npm run tauri build -- --target universal-apple-darwin   # universal .app + .dmg (Apple Silicon + Intel)
# output: src-tauri/target/universal-apple-darwin/release/bundle/
```

Requires both Rust targets (`rustup target add aarch64-apple-darwin x86_64-apple-darwin`). To build
only for the current Mac, drop `--target` (Apple Silicon produces an aarch64 build; an Intel Mac an
x86_64 build). Pass `--bundles app` or `--bundles dmg` to build just one format.

### Linux (local)

```bash
npm run tauri build                    # all available Linux bundles
npm run tauri build -- --bundles deb   # just the .deb
# output: src-tauri/target/release/bundle/
```

### Windows + Linux + macOS (via CI)

Installers are produced by **GitHub Actions**. Push a version tag and the release workflow
builds the installers and attaches them to a **draft** GitHub Release for review:

```bash
git tag v0.1.0
git push origin v0.1.0
```

- Windows: `.msi` (WiX), `.exe` (NSIS) installer, and a standalone portable `.exe`. Linux: `.deb` and `.AppImage`. macOS: universal `.app` and `.dmg`.
- All artifacts land on a single draft Release. See `.github/workflows/release.yml` — the release is created as a draft, so review and publish it manually.
- macOS builds are **unsigned** unless the `APPLE_*` repository secrets are set (see comments in `release.yml`).

## Architecture

The wallet is a small native shell built with **Tauri v2**, a **React + TypeScript** frontend styled
with **Tailwind**, and the **Keryx wallet-core** compiled to WebAssembly (`src/sdk/`). The cryptography
is the upstream wallet library rather than a reimplementation, so key handling matches the rest of the
ecosystem. Regenerating the SDK from a newer node release is documented in `SDK_CONTRACT.md`.

## Security

- The recovery phrase is encrypted at rest (Argon2 key derivation, XChaCha20-Poly1305 encryption) and
  is never written to logs. Keys are derived in memory only, and the password is requested again for
  every send.
- A send freezes the confirmed amounts — what you confirm is exactly what is signed — and validates the
  destination address and network beforehand.
- A strict Content Security Policy blocks remote content and inline/eval scripts, and Tauri capabilities
  are limited to the defaults.

## Support the project

Keryx Wallet is free and open source. If it's useful to you and you'd like to help its
development, donations are very welcome — thank you!

- **KRX (Keryx):** `keryx:qpx2alq86yev9xs3jqf3endplycf27vq3qxf7gaxvxnedacnl7y0xyvwq3slp`
- **USDT / USDC (EVM — Ethereum, BNB Chain, and other EVM networks):** `0xe5c66e65a5b2085e5313796dd2a1C90aB276cD8d`
  _(EVM / ERC-20 / BEP-20 tokens only — do not send from non-EVM chains.)_

## License

MIT — see [`LICENSE`](LICENSE).
