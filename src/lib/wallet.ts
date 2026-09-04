// Keryx wallet service — wraps the audited wallet-core WASM SDK.
// Wired strictly against SDK_CONTRACT.md. We NEVER log password / mnemonic / seed.

import * as kaspa from "../sdk/kaspa.js";
import wasmUrl from "../sdk/kaspa_bg.wasm?url";
import {
  buildAiRequestTx,
  computeInferenceReward,
  MODELS,
  ModelName,
  RequestUtxo,
  MIN_AI_REQUEST_PRIORITY_FEE,
  hexToBytes,
} from "./aiRequest";
import { escrowForModel } from "./aiCaps";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  parseAiResponse,
  ipfsUrl,
  SUBNETWORK_ID_AI_RESPONSE_HEX,
} from "./aiResponse";

const WALLET_FILENAME = "main";
const WALLET_TITLE = "Keryx";
// The SDK does not expose a way to read back the stored mnemonic (IPrvKeyDataGetResponse is
// empty in this build), so to support "reveal recovery phrase" we keep our OWN copy of the
// phrase, encrypted with the SAME password via the SDK's XChaCha20-Poly1305 (same scheme as the
// wallet file → no new exposure). Decryptable only with the correct password.
const SEED_BLOB_KEY = "keryx.wallet.seed.v1";
// Local activity log. The node exposes no per-address transaction history (only the current UTXO
// set + mempool), and our send/consolidate go through a manual submit path that bypasses the SDK's
// high-level transaction record store — so outgoing transactions never land in transactionsDataGet.
// We therefore persist every send/consolidate WE make here and merge it into history(). Only txids
// (already public on-chain) and amounts are stored — never keys or the seed. Cleared on a new
// wallet (create/import) so it can't show another seed's activity.
const LOCAL_ACTIVITY_KEY = "keryx.wallet.activity.v1";
const RECEIVED_LOG_KEY = "keryx.wallet.received.v1";
const RECEIVE_LIST_KEY = "keryx.wallet.receivelist.v1";
const RECEIVE_ACTIVE_KEY = "keryx.wallet.receiveactive.v1";

/*
 * MULTI-WALLET STORAGE
 *
 * Each "wallet" the user sees is its own seed (one prvKeyData) with its own bip32 account, and all
 * of them live inside the SAME SDK wallet file. That is deliberate: one file means ONE
 * walletSecret, so the password is shared by construction and walletChangeSecret rotates every
 * wallet at once. Verified against this SDK build — two prvKeyData in one file yield two accounts
 * with distinct addresses, accountsRename works, and after a rotation the old password is rejected
 * for all of them. Separate wallet files would each carry their own password, which is exactly what
 * we do not want.
 *
 * SEED_BLOB_KEY (single blob) is the pre-multi-wallet layout and is migrated into SEED_BLOBS_KEY on
 * the first open. It is deliberately NOT deleted, so an older build still opens the same wallet.
 */
const SEED_BLOBS_KEY = "keryx.wallet.seeds.v1"; // { [prvKeyDataId]: encrypted mnemonic }
/** Local alias overrides, so renaming costs no password. The SDK's accountName is set at creation
 *  and remains the fallback — it is what survives a wallet-file export/restore. */
const ALIASES_KEY = "keryx.wallet.aliases.v1"; // { [accountId]: alias }
/**
 * accountIds the user removed from THIS APP'S list. Local and reversible by design: the wallet
 * file, the account and its recovery phrase are all left untouched, so a hidden wallet keeps
 * mining, keeps its balance, and comes back intact when restored. Nothing here reaches the
 * network — coins live on the chain, not in this list.
 */
const HIDDEN_WALLETS_KEY = "keryx.wallet.hidden.v1"; // accountId[]
const ACTIVE_WALLET_KEY = "keryx.wallet.activewallet.v1"; // accountId
/** Receive-address switcher, keyed BY ACCOUNT. The v1 keys were a flat list from when there was one
 *  seed; sharing them across wallets would offer an address derived from another seed, which the
 *  active account cannot sign for. Migrated on first open. */
const RECEIVE_LIST_BY_ACCOUNT_KEY = "keryx.wallet.receivelist.v2";
const RECEIVE_ACTIVE_BY_ACCOUNT_KEY = "keryx.wallet.receiveactive.v2";
/** Receive+change depth scanned per wallet when summing the all-wallets total. */
const TOTALS_DEPTH = 20;
/** How many of an account's addresses to test for mining production before giving up. */
const HOLDER_REWARD_SCAN_LIMIT = 20;

/** Base URL of the Keryx Labs explorer API for the active network. */
function explorerApiBase(networkId: string): string {
  return networkId === "mainnet" ? "https://keryx-labs.com" : "https://testnet.keryx-labs.com";
}

/** JSON integer (sompi / DAA) to bigint; null, undefined and non-numbers read as 0n. */
function jsonBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

export interface NodeSettings {
  url: string;
  networkId: string;
}

/** Domain of the H6 escrow delegation message, as verified by the miner and the node. */
const ESCROW_DELEGATION_DOMAIN = "KeryxEscrowDelegationV1";

/** Public Keryx Labs nodes, one per network. */
export const DEFAULT_NODES: Record<string, NodeSettings> = {
  mainnet: { url: "wss://node.keryx-labs.com:23110", networkId: "mainnet" },
  "testnet-10": { url: "wss://node.keryx-labs.com:23210", networkId: "testnet-10" },
};

export const DEFAULT_NODE: NodeSettings = DEFAULT_NODES.mainnet;

/** One user-visible wallet: its own recovery phrase, its own account, its own addresses. */
export interface WalletEntry {
  accountId: string;
  prvKeyDataId: string | null;
  alias: string;
  receiveAddress: string | null;
  /** We hold a password-encrypted copy of this wallet's phrase, so it can be revealed/backed up. */
  hasSeed: boolean;
  /** Mature sompi from the last totals refresh; null until one has run. For the ACTIVE wallet the
   *  live `balance.mature` is authoritative instead — see totalBalanceSompi. */
  balanceSompi: bigint | null;
}

export interface WalletBalance {
  mature: bigint;
  pending: bigint;
}

export type ConnStatus = "disconnected" | "connecting" | "connected";

export interface WalletStatus {
  initialized: boolean;
  addressPrefix: string | null; // verified runtime prefix, e.g. "keryx"
  conn: ConnStatus;
  synced: boolean;
}

/** Normalized activity entry derived from ITransactionRecord. */
export interface HistoryEntry {
  id: string;
  /** Raw SDK data type, e.g. incoming, outgoing, external, transfer-incoming. */
  type: string;
  /** Convenience direction derived from the type. */
  direction: "in" | "out" | "other";
  /** Value in sompi (bigint, unsigned). */
  amountSompi: bigint;
  /** UNIX time in ms, if the SDK provided it. */
  timestamp?: number;
  /** The account address this tx was sent FROM (for per-account filtering). */
  fromAddress?: string;
}

/** One currently/previously received UTXO, surfaced as an incoming entry (per-account). */
export interface ReceivedEntry {
  txid: string;
  index: number;
  amountSompi: bigint;
  timestamp?: number;
  isCoinbase?: boolean;
  /** The account address this deposit landed on (for per-account filtering). */
  address?: string;
}

/** Result of an estimate: fee + total to spend (both sompi). */
export interface SendEstimate {
  feeSompi: bigint;
  /** amount + fee (best-effort; finalAmount already includes fees when present). */
  totalSompi: bigint;
  /** Raw summary (only set by the async Generator path; sync path omits it). */
  summary?: kaspa.GeneratorSummary;
}

/** Per-batch progress reported by the consolidate auto-loop after each confirmed batch. */
export interface ConsolidateProgress {
  /** 1-based index of the batch that just confirmed. */
  batch: number;
  /** Submitted transaction id of that batch. */
  txid: string;
  /** UTXOs left on the wallet after this batch confirmed. */
  remaining: number;
}

/**
 * Live state of a consolidation run. Lives on the service, not in the modal, so the run survives
 * closing the window and reopening shows the truth instead of a blank form.
 */
export interface ConsolidateRun {
  running: boolean;
  /** 1-based current round. Each round divides the UTXO count by ~MAX_TX_INPUTS. */
  round: number;
  /** Rounds still expected, derived from the current count (log_80(N), so usually 1–3). */
  roundsEstimate: number;
  /** UTXOs when the run started, and right now. */
  startCount: number;
  remaining: number;
  txsSubmitted: number;
  txsFailed: number;
  /** Submitted transaction ids, so reopening the window after the run still shows the result. */
  txids: string[];
  /** Fees actually committed so far (submitted txs × the per-tx minimum fee). */
  feePaidSompi: bigint;
  startedAt: number;
  /** Set when the run stopped early; also shown while running as a non-fatal warning. */
  lastError: string | null;
  stopRequested: boolean;
  /** What the run is doing right now, for the progress line. */
  phase: "building" | "submitting" | "waiting" | "done" | "stopped" | "failed";
}

/** Stable identity for a UTXO (transactionId:index), used to tell when a batch's inputs are gone. */
function outpointKey(e: { outpoint?: { transactionId?: string; index?: number } }): string {
  const op = e.outpoint ?? {};
  return `${op.transactionId ?? ""}:${op.index ?? 0}`;
}

type Listener = () => void;

class WalletService {
  private wallet: kaspa.Wallet | null = null;
  private wasmReady = false;
  /** In-flight init(), so concurrent callers share one WASM instantiation. See init(). */
  private initPromise: Promise<void> | null = null;
  /** Endpoint the current `wallet` was built for, so setNode can skip a pointless rebuild. */
  private walletEndpoint: string | null = null;
  private _accountId: string | null = null;
  private _networkId: string = DEFAULT_NODE.networkId;
  /** Wallet secret held while unlocked so signing does not prompt again; dropped on lock. */
  private signingSecret: string | null = null;
  /** Endpoint last requested through setNode; what ensureWallet rebuilds against. */
  private nodeSettings: NodeSettings = DEFAULT_NODE;
  /** The account address found to be mining, so the sweep runs once — see `holderReward`. */
  private holderRewardAddress: string | null = null;

  // observable state
  addressPrefix: string | null = null;
  conn: ConnStatus = "disconnected";
  synced = false;
  scanning = false; // wallet is discovering its addresses/UTXOs after opening
  nodeDaa: bigint | null = null; // node's virtual DAA score (tip), polled live
  hasUtxoIndex: boolean | null = null; // node started with --utxoindex? required for balances
  receiveAddress: string | null = null;
  /** The user's chosen receive addresses (MetaMask-style switcher), capped at MAX_RECEIVE_ADDRESSES.
   *  receiveAddress is whichever of these is currently selected. */
  receiveAddresses: string[] = [];
  static readonly MAX_RECEIVE_ADDRESSES = 3;
  /** Public-key generator cached at open() (no private keys) so "My addresses" can derive + scan the
   *  wallet's addresses WITHOUT asking for the password again. Dropped on lock. */
  private pubGen: kaspa.PublicKeyGenerator | null = null;
  /** Every wallet in the file, in creation order. Empty while locked. */
  wallets: WalletEntry[] = [];
  /** Per-wallet public-key generators, derived at open() from each stored phrase. Memory only. */
  private pubGens = new Map<string, kaspa.PublicKeyGenerator>();
  /**
   * Account descriptors by accountId, cached when the registry is built.
   *
   * Switching wallets used to re-read them with accountsEnumerate, which shares the SDK's single
   * WASM thread with the UTXO scan and so could sit behind it for more than ten seconds — the
   * "timeout after 10000ms (accountsEnumerate-select)" a switch could fail with. open() has
   * already fetched every descriptor, so a switch reads them from here and touches no RPC.
   */
  private descriptorCache = new Map<string, any>();
  /** accountId of a wallet switch in flight, so the UI can show it instead of stale zeros. */
  switchingWallet: string | null = null;
  /** Live consolidation state, or null if none has run this session. Kept here rather than in the
   *  modal so the run survives closing it and reopening shows the real state. */
  consolidateRun: ConsolidateRun | null = null;
  balance: WalletBalance = { mature: 0n, pending: 0n };
  lastError: string | null = null;

  private listeners = new Set<Listener>();
  private pollTimer: number | null = null;
  private scanTimer: number | null = null;
  private fallbackTimer: number | null = null;
  private gotBalanceEvent = false; // a real "balance" event takes precedence over the fallback sum
  private accountAddresses: string[] = []; // receive+change(+more) for the direct-UTXO fallback
  private txInFlight = false; // serializes the manual send/consolidate money path (one tx at a time)
  // --- instrumentation (debugging the empty-context / send-hang issue) ---
  private eventCount = 0;
  private lastEventTypes: string[] = [];
  private activateError: string | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  get isInitialized() {
    return this.wasmReady;
  }
  get isOpen() {
    return this._accountId !== null;
  }
  private requireSigningSecret(): string {
    if (this.signingSecret === null) throw new Error("Wallet is locked.");
    return this.signingSecret;
  }
  /** Active account id (hex), or null when locked. */
  get accountId(): string | null {
    return this._accountId;
  }
  /** Active network id string, e.g. "mainnet". */
  get networkId(): string {
    return this._networkId;
  }
  /** How many wallets (separate recovery phrases) this file holds. */
  get walletCount(): number {
    return this.wallets.length;
  }
  /** The wallet whose account is currently active, or null when locked. */
  get activeWallet(): WalletEntry | null {
    return this.wallets.find((w) => w.accountId === this._accountId) ?? null;
  }
  /**
   * Mature balance across every wallet. The active wallet contributes its LIVE balance (the same
   * number the dashboard shows) rather than its last polled one, so the total can never disagree
   * with the headline figure; the others contribute their last totals refresh.
   */
  get totalBalanceSompi(): bigint {
    let total = 0n;
    for (const e of this.wallets) {
      // Mid-switch the active wallet's live balance is still 0 (not read yet), so fall back to its
      // last poll — otherwise the total visibly dips every time you change wallet.
      const useLive = e.accountId === this._accountId && this.switchingWallet === null;
      total += useLive ? this.balance.mature : (e.balanceSompi ?? 0n);
    }
    return total;
  }

  /**
   * Load WASM and verify (at runtime) the real Keryx address prefix.
   *
   * Concurrency-safe on purpose. `wasmReady` is only set at the END of the work, so two
   * overlapping calls both used to get past the guard — and wasm-bindgen's own
   * `if (wasm !== undefined) return wasm` guard is likewise only armed after instantiation
   * resolves, so both proceeded to instantiate the module. That left TWO WebAssembly
   * instances with separate linear memories while the glue's module-level binding pointed at
   * whichever finished last: every handle created against the first instance (the Wallet, keys)
   * became a dangling pointer into the wrong memory. It surfaced as wallet-store calls hanging
   * forever and "RuntimeError: memory access out of bounds", i.e. wallet creation never
   * finishing. React StrictMode double-invokes effects in dev, which is exactly how the app hit
   * it; a remount can do the same in production. Sharing the in-flight promise makes the second
   * caller await the first instantiation instead of starting another.
   */
  init(): Promise<void> {
    if (this.wasmReady) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = this.loadWasm().catch((e) => {
        this.initPromise = null; // let a later attempt retry rather than latch the failure
        throw e;
      });
    }
    return this.initPromise;
  }

  private async loadWasm(): Promise<void> {
    await kaspa.default(wasmUrl);
    // Runtime prefix verification (the .d.ts shows upstream "kaspa:" but the
    // Keryx build emits a different prefix). Derive a throwaway address.
    try {
      const sample =
        "0000000000000000000000000000000000000000000000000000000000000001";
      const addr = new kaspa.PrivateKey(sample)
        .toAddress("mainnet")
        .toString();
      const prefix = addr.split(":")[0] || null;
      this.addressPrefix = prefix;
      if (prefix === "keryx") {
        console.info("[wallet] address prefix verified:", prefix);
      } else {
        console.warn(
          "[wallet] unexpected address prefix (expected 'keryx'):",
          prefix
        );
      }
    } catch (e) {
      console.error("[wallet] prefix verification failed", e);
    }
    this.wasmReady = true;
    this.emit();
  }

  /** Whether a wallet already exists in local storage. Gates onboarding vs unlock. */
  async exists(): Promise<boolean> {
    this.ensureWallet();
    return await this.wallet!.exists(WALLET_FILENAME);
  }

  /**
   * Step 1 of creation: produce a 24-word mnemonic for the user to back up.
   * Nothing is persisted yet. Returns the phrase (caller must NOT log it).
   */
  create(): string {
    if (!this.wasmReady) throw new Error("WASM not initialized");
    const m = kaspa.Mnemonic.random(24);
    return m.phrase;
  }

  /**
   * Step 2 of creation: persist the wallet file, store the private key data from the (backed-up)
   * mnemonic, create its account and open it. This is the FIRST wallet — its password becomes the
   * file's walletSecret, which every wallet added later then shares.
   */
  async finishCreate(
    password: string,
    mnemonicPhrase: string,
    alias?: string
  ): Promise<void> {
    this.ensureWallet();
    const w = this.wallet!;
    const name = WalletService.cleanAlias(alias, 1);
    await w.walletCreate({
      walletSecret: password,
      filename: WALLET_FILENAME,
      title: WALLET_TITLE,
    });
    const pk = await w.prvKeyDataCreate({
      walletSecret: password,
      kind: "mnemonic",
      mnemonic: mnemonicPhrase,
      name,
    });
    await w.accountsCreate({
      walletSecret: password,
      type: "bip32",
      accountName: name,
      prvKeyDataId: pk.prvKeyDataId,
    });
    this.storeSeedBackup(String(pk.prvKeyDataId), mnemonicPhrase, password);
    this.clearLocalActivity(); // fresh wallet → don't inherit a previous seed's activity
    await this.open(password);
  }

  /** Import an existing 12/24-word mnemonic as the FIRST wallet in a fresh file, then open it. */
  async importMnemonic(
    password: string,
    phrase: string,
    alias?: string
  ): Promise<void> {
    const clean = phrase.trim().replace(/\s+/g, " ");
    if (!kaspa.Mnemonic.validate(clean)) {
      throw new Error("Invalid recovery phrase.");
    }
    this.ensureWallet();
    const w = this.wallet!;
    const name = WalletService.cleanAlias(alias, 1);
    await w.walletCreate({
      walletSecret: password,
      filename: WALLET_FILENAME,
      title: WALLET_TITLE,
    });
    const pk = await w.prvKeyDataCreate({
      walletSecret: password,
      kind: "mnemonic",
      mnemonic: clean,
      name,
    });
    await w.accountsCreate({
      walletSecret: password,
      type: "bip32",
      accountName: name,
      prvKeyDataId: pk.prvKeyDataId,
    });
    this.storeSeedBackup(String(pk.prvKeyDataId), clean, password);
    this.clearLocalActivity(); // imported wallet → start its activity log clean
    await this.open(password);
  }

  /**
   * Add ANOTHER wallet (its own recovery phrase) to the already-open file, and make it active.
   *
   * The password is required again because we deliberately never keep it in memory — and it is the
   * file's single walletSecret, so this is the same password every other wallet uses. Deliberately
   * does NOT clear the local activity log: that log is shared by every wallet in the file, keyed by
   * address, and wiping it here would erase the other wallets' history.
   */
  async addWallet(
    password: string,
    phrase: string,
    alias?: string
  ): Promise<string> {
    if (!this.isOpen) throw new Error("Unlock the wallet first.");
    const w = this.wallet!;
    const clean = phrase.trim().replace(/\s+/g, " ");
    if (!kaspa.Mnemonic.validate(clean)) {
      throw new Error("Invalid recovery phrase.");
    }
    // Two accounts on the same phrase would show the same coins twice and double the total, so
    // refuse a phrase already in the file. Compared by the index-0 address it derives to, which is
    // cheap and local.
    const existing = this.firstAddressOf(clean);
    if (existing) {
      const dup = this.wallets.find((e) => e.receiveAddress === existing);
      if (dup) {
        throw new Error(`That phrase is already in this wallet, as "${dup.alias}".`);
      }
    }
    const name = WalletService.cleanAlias(alias, this.wallets.length + 1);
    let pk;
    try {
      pk = await w.prvKeyDataCreate({
        walletSecret: password,
        kind: "mnemonic",
        mnemonic: clean,
        name,
      });
    } catch {
      throw new Error("Could not add the wallet (wrong password?).");
    }
    const created = await w.accountsCreate({
      walletSecret: password,
      type: "bip32",
      accountName: name,
      prvKeyDataId: pk.prvKeyDataId,
    });
    this.storeSeedBackup(String(pk.prvKeyDataId), clean, password);
    const accountId = WalletService.accountIdOf(created);
    await this.refreshRegistry(password);
    if (accountId) await this.selectWallet(accountId);
    this.emit();
    return accountId ?? "";
  }

  /** The index-0 receive address a phrase derives to on the active network, or null. */
  private firstAddressOf(phrase: string): string | null {
    try {
      const seed = new kaspa.Mnemonic(phrase).toSeed();
      const gen = kaspa.PublicKeyGenerator.fromMasterXPrv(
        new kaspa.XPrv(seed).toString(),
        false,
        0n
      );
      return gen.receiveAddressAsStrings(this._networkId, 0, 1)[0] ?? null;
    } catch {
      return null;
    }
  }

  private static accountIdOf(created: unknown): string | null {
    const c = created as { accountDescriptor?: { accountId?: unknown }; accountId?: unknown };
    const id = c?.accountDescriptor?.accountId ?? c?.accountId;
    return id ? String(id) : null;
  }

  private static cleanAlias(alias: string | undefined, index: number): string {
    const trimmed = (alias ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return trimmed || `Wallet ${index}`;
  }

  /** Rename a wallet. Local-only, so it costs no password — see ALIASES_KEY. */
  renameWallet(accountId: string, alias: string): void {
    const entry = this.wallets.find((e) => e.accountId === accountId);
    if (!entry) throw new Error("Unknown wallet.");
    const name = WalletService.cleanAlias(
      alias,
      this.wallets.indexOf(entry) + 1
    );
    entry.alias = name;
    try {
      const map = this.readAliases();
      map[accountId] = name;
      localStorage.setItem(ALIASES_KEY, JSON.stringify(map));
    } catch {
      /* non-fatal: the SDK accountName remains as the fallback */
    }
    this.emit();
  }

  /** accountIds of every wallet hidden from this app's list, in on-disk order. */
  get hiddenWalletIds(): string[] {
    return [...this.readHiddenWallets()];
  }

  /**
   * Remove a wallet from this app's list. LOCAL AND REVERSIBLE: the wallet file, the account and
   * its recovery phrase are untouched, so nothing is destroyed and nothing changes on the chain —
   * the address keeps its balance and keeps mining. `restoreWallet` brings it back.
   *
   * Two refusals, both to avoid a state with no way out: the active wallet (switch first, so the
   * app is never left pointing at a wallet it no longer lists) and the last visible one (hiding it
   * would leave an open wallet file with an empty switcher).
   */
  hideWallet(accountId: string): void {
    const entry = this.wallets.find((e) => e.accountId === accountId);
    if (!entry) throw new Error("Unknown wallet.");
    if (accountId === this._accountId) {
      throw new Error("This is the active wallet. Switch to another one first, then remove it.");
    }
    if (this.wallets.length <= 1) {
      throw new Error("This is your only wallet. Add another one before removing this one.");
    }
    const hidden = this.readHiddenWallets();
    hidden.add(accountId);
    this.writeHiddenWallets(hidden);
    this.wallets = this.wallets.filter((e) => e.accountId !== accountId);
    this.emit();
  }

  /** Put a hidden wallet back in the list. Rebuilds from the cached descriptor — no RPC, no
   *  password: nothing was ever removed, so there is nothing to recover. */
  restoreWallet(accountId: string): void {
    const hidden = this.readHiddenWallets();
    if (!hidden.delete(accountId)) return;
    this.writeHiddenWallets(hidden);
    const descriptors = [...this.descriptorCache.values()];
    if (descriptors.length) this.wallets = this.buildRegistry(descriptors);
    this.emit();
  }

  /**
   * Display label for a hidden wallet: its local alias, else its receive address, else the raw
   * accountId. Read from the descriptor cache, which deliberately keeps hidden accounts, so a
   * removed wallet is still recognisable in the restore list rather than an opaque id.
   */
  hiddenWalletLabel(accountId: string): string {
    const alias = this.readAliases()[accountId];
    if (alias) return alias;
    const d = this.descriptorCache.get(accountId);
    const name = typeof d?.accountName === "string" ? d.accountName : null;
    if (name) return name;
    const addr = d?.receiveAddress ? String(d.receiveAddress) : null;
    return addr ?? accountId;
  }

  private readHiddenWallets(): Set<string> {
    try {
      const raw = localStorage.getItem(HIDDEN_WALLETS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
    } catch {
      // Unreadable ⇒ hide nothing. Erring towards showing a wallet is the safe direction: the
      // opposite would make a wallet the user still has quietly disappear.
      return new Set();
    }
  }

  private writeHiddenWallets(ids: Set<string>): void {
    try {
      localStorage.setItem(HIDDEN_WALLETS_KEY, JSON.stringify([...ids]));
    } catch {
      /* non-fatal: the wallet reappears on the next open, which is the harmless direction */
    }
  }

  private readAliases(): Record<string, string> {
    try {
      const raw = localStorage.getItem(ALIASES_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  // --- per-wallet seed backups -------------------------------------------------------------
  // The SDK exposes no way to read a stored mnemonic back (IPrvKeyDataGetResponse is empty in this
  // build), so we keep our own copy per seed, encrypted with the wallet password using the SDK's
  // XChaCha20-Poly1305 — the same scheme the wallet file uses, so no new exposure. Keyed by
  // prvKeyDataId because that is what identifies a seed; account ids are per-account.

  private readSeedBlobs(): Record<string, string> {
    try {
      const raw = localStorage.getItem(SEED_BLOBS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeSeedBlobs(map: Record<string, string>): void {
    try {
      localStorage.setItem(SEED_BLOBS_KEY, JSON.stringify(map));
    } catch {
      /* non-fatal: reveal just won't be available */
    }
  }

  /** Encrypt one wallet's mnemonic with the wallet password and persist it (for reveal/backup). */
  private storeSeedBackup(
    prvKeyDataId: string,
    phrase: string,
    password: string
  ): void {
    if (!prvKeyDataId) return;
    try {
      const map = this.readSeedBlobs();
      map[prvKeyDataId] = kaspa.encryptXChaCha20Poly1305(phrase, password);
      this.writeSeedBlobs(map);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Pull the pre-multi-wallet single blob into the keyed map, so an existing wallet keeps its
   * "reveal phrase" after the upgrade. The legacy key is left in place on purpose: an older build
   * of the app must still be able to open the same wallet.
   */
  private migrateLegacySeedBlob(prvKeyDataId: string | null): void {
    if (!prvKeyDataId) return;
    try {
      const legacy = localStorage.getItem(SEED_BLOB_KEY);
      if (!legacy) return;
      const map = this.readSeedBlobs();
      if (map[prvKeyDataId]) return; // already migrated
      map[prvKeyDataId] = legacy;
      this.writeSeedBlobs(map);
    } catch {
      /* non-fatal */
    }
  }

  /** True if a recovery phrase is available to reveal for a wallet (default: the active one). */
  hasSeedBackup(accountId?: string): boolean {
    const id = this.prvKeyDataIdFor(accountId ?? this._accountId);
    if (!id) return false;
    return !!this.readSeedBlobs()[id];
  }

  private prvKeyDataIdFor(accountId: string | null): string | null {
    if (!accountId) return null;
    return (
      this.wallets.find((w) => w.accountId === accountId)?.prvKeyDataId ?? null
    );
  }

  /**
   * Reveal a wallet's recovery phrase (default: the active wallet). Decrypts our own
   * password-encrypted copy; the correct password is required (a wrong one throws). The phrase is
   * returned to the caller, never logged.
   */
  revealMnemonic(password: string, accountId?: string): string {
    const id = this.prvKeyDataIdFor(accountId ?? this._accountId);
    const blob = id ? this.readSeedBlobs()[id] : undefined;
    if (!blob) {
      throw new Error("No recovery phrase is stored for this wallet.");
    }
    return WalletService.decryptPhrase(blob, password);
  }

  /**
   * Decrypt one stored phrase. Decryption failing is the password being wrong; a successful
   * decrypt that yields an invalid phrase means the stored blob is corrupted, not a bad password —
   * report the two distinctly so the user is not misled.
   */
  private static decryptPhrase(blob: string, password: string): string {
    let phrase: string;
    try {
      phrase = kaspa.decryptXChaCha20Poly1305(blob, password);
    } catch {
      throw new Error("Wrong password.");
    }
    if (!phrase || !kaspa.Mnemonic.validate(phrase.trim())) {
      throw new Error("Stored recovery phrase is invalid or corrupted.");
    }
    return phrase;
  }

  /**
   * Change the password. One walletSecret covers every wallet in the file, so a single
   * walletChangeSecret rotates all of them at once — there is no per-wallet password to keep in
   * sync. Our own phrase copies are decrypted with the OLD password first (which also verifies it)
   * and re-encrypted with the NEW one afterwards, so "reveal phrase" keeps working for every
   * wallet. Requires the wallet to be open.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.isOpen) throw new Error("Open the wallet first.");
    const w = this.wallet!;
    // Decrypt everything BEFORE touching the wallet secret: if the old password is wrong we must
    // fail without having rotated anything.
    const blobs = this.readSeedBlobs();
    const phrases: Record<string, string> = {};
    for (const [id, blob] of Object.entries(blobs)) {
      phrases[id] = WalletService.decryptPhrase(blob, oldPassword); // throws "Wrong password."
    }
    try {
      await w.walletChangeSecret({
        oldWalletSecret: oldPassword,
        newWalletSecret: newPassword,
      });
    } catch {
      throw new Error("Could not change password (wrong current password?).");
    }
    const next: Record<string, string> = {};
    for (const [id, phrase] of Object.entries(phrases)) {
      next[id] = kaspa.encryptXChaCha20Poly1305(phrase, newPassword);
    }
    if (Object.keys(next).length > 0) this.writeSeedBlobs(next);
  }

  /**
   * Export the ENCRYPTED wallet file (a password-protected hex blob) for backup. It is NOT
   * plaintext — it can only be opened with the wallet password. Requires the wallet to be open.
   */
  async exportWallet(password: string): Promise<string> {
    if (!this.isOpen) throw new Error("Open the wallet first.");
    const w = this.wallet!;
    try {
      const r = await w.walletExport({
        walletSecret: password,
        includeTransactions: false,
      });
      return r.walletData;
    } catch {
      throw new Error("Could not export wallet (wrong password?).");
    }
  }

  /**
   * Restore from a previously exported ENCRYPTED wallet file (the hex blob from exportWallet).
   * The password must match the one the file was exported with. Note: a file restore does NOT
   * recover the plaintext mnemonic, so "reveal phrase" is unavailable for a file-restored wallet
   * (restore by phrase if you need that). Then opens the wallet.
   */
  async restoreFromFile(password: string, walletData: string): Promise<void> {
    const clean = walletData.trim().replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length < 16) {
      throw new Error("That does not look like a valid wallet backup file.");
    }
    this.ensureWallet();
    const w = this.wallet!;
    try {
      await w.walletImport({ walletSecret: password, walletData: clean });
    } catch {
      throw new Error("Could not restore (wrong password or corrupt file).");
    }
    await this.open(password);
  }

  /** Open / unlock the wallet, activate the first account and connect to the node. */
  async open(password: string): Promise<void> {
    this.ensureWallet();
    const w = this.wallet!;
    let opened;
    try {
      opened = await w.walletOpen({
        walletSecret: password,
        filename: WALLET_FILENAME,
        accountDescriptors: true,
      });
    } catch (e) {
      // Most common failure here is a wrong password.
      throw new Error("Could not unlock wallet (wrong password?).");
    }
    const descriptors = (opened.accountDescriptors ?? []) as any[];
    if (descriptors.length === 0) {
      throw new Error("Wallet has no accounts.");
    }
    this.signingSecret = password;
    // Every account in the file is one wallet (one seed). A pre-multi-wallet file has exactly one,
    // so this collapses to the old behaviour for it.
    this.migrateLegacySeedBlob(WalletService.prvKeyIdOf(descriptors[0]));
    this.wallets = this.buildRegistry(descriptors);
    this.derivePubGens(password);
    this.migrateLegacyReceiveList(String(descriptors[0].accountId));

    const wanted = this.readActiveWalletId();
    // Resolve the active account among the VISIBLE ones. Adopting a wallet the user removed from
    // the list would leave the app pointing at a wallet its own switcher does not show — no way to
    // switch away, and a balance on screen with no entry to match it. Reachable whenever the
    // hidden list and the stored active id fall out of step (one key cleared, not the other).
    const visible = this.wallets.map((e) => e.accountId);
    const acc =
      descriptors.find((d) => String(d.accountId) === wanted && visible.includes(String(d.accountId))) ??
      descriptors.find((d) => visible.includes(String(d.accountId)));
    if (acc) {
      this.adoptAccount(acc);
    } else {
      // Every account in the file is hidden — a state the UI refuses to create, so it means the
      // hidden list is stale. Showing a wallet the user still owns beats opening into an empty
      // switcher, so drop the list and start over from the file.
      this.writeHiddenWallets(new Set());
      this.wallets = this.buildRegistry(descriptors);
      this.adoptAccount(descriptors.find((d) => String(d.accountId) === wanted) ?? descriptors[0]);
    }

    // UNLOCK = walletOpen succeeded (the wallet is decrypted). That is LOCAL and fast. We must NOT
    // block the unlock on anything network-bound: connecting to the node, starting the processor,
    // and especially activating the account (which kicks off the UTXO scan and can be slow or
    // stall) all run in the BACKGROUND below. The UI shows the dashboard immediately and the
    // connection/scan/balance fill in via the status bar - so "unlocking" can never hang.
    this.conn = "connecting";
    this.emit();
    void this.connectActivateScan(this._accountId!);
  }

  // --- wallet registry ----------------------------------------------------------------------

  /** Point local state at one account: its addresses, its switcher list, its key generator. */
  private adoptAccount(acc: any): void {
    this._accountId = String(acc.accountId);
    this.receiveAddress = acc.receiveAddress ? acc.receiveAddress.toString() : null;
    this.gotBalanceEvent = false;
    this.holderRewardAddress = null;
    this.accountAddresses = this.collectDescriptorAddresses(acc);
    // Each wallet needs ITS OWN generator: another seed's would derive addresses this account
    // cannot sign for.
    this.pubGen = this.pubGens.get(this._accountId) ?? null;
    this.initReceiveList();
    this.writeActiveWalletId(this._accountId);
  }

  private static prvKeyIdOf(d: any): string | null {
    const ids = d?.prvKeyDataIds;
    const first = Array.isArray(ids) ? ids[0] : undefined;
    return first ? String(first) : null;
  }

  private buildRegistry(descriptors: any[]): WalletEntry[] {
    this.descriptorCache.clear();
    // The cache keeps EVERY descriptor, hidden ones included: restoring must not have to go back
    // to accountsEnumerate, which shares the SDK's single WASM thread with the UTXO scan.
    for (const d of descriptors) this.descriptorCache.set(String(d.accountId), d);
    const hidden = this.readHiddenWallets();
    // A hidden wallet drops out of the switcher, the all-wallets total and the balance polling
    // loop in one move, because every one of them reads `this.wallets`.
    descriptors = descriptors.filter((d) => !hidden.has(String(d.accountId)));
    const aliases = this.readAliases();
    const blobs = this.readSeedBlobs();
    const previous = new Map(this.wallets.map((w) => [w.accountId, w]));
    return descriptors.map((d, i) => {
      const accountId = String(d.accountId);
      const prvKeyDataId = WalletService.prvKeyIdOf(d);
      return {
        accountId,
        prvKeyDataId,
        // A local rename wins; otherwise the SDK accountName, which is what survives a
        // wallet-file export/restore.
        alias: aliases[accountId] || d.accountName || "Wallet " + (i + 1),
        receiveAddress: d.receiveAddress ? d.receiveAddress.toString() : null,
        hasSeed: !!(prvKeyDataId && blobs[prvKeyDataId]),
        // Keep any balance already polled, so switching wallets doesn't blank the list.
        balanceSompi: previous.get(accountId)?.balanceSompi ?? null,
      };
    });
  }

  /**
   * Derive one PUBLIC key generator per wallet (no private keys) so address scanning and the
   * all-wallets total work later without asking for the password again - we hold the password
   * exactly once, here at open. Non-fatal per wallet: one unreadable blob must not block unlock.
   */
  private derivePubGens(password: string): void {
    this.pubGens.clear();
    const blobs = this.readSeedBlobs();
    for (const entry of this.wallets) {
      const blob = entry.prvKeyDataId ? blobs[entry.prvKeyDataId] : undefined;
      if (!blob) continue;
      try {
        const phrase = WalletService.decryptPhrase(blob, password);
        const seed = new kaspa.Mnemonic(phrase).toSeed();
        this.pubGens.set(
          entry.accountId,
          kaspa.PublicKeyGenerator.fromMasterXPrv(
            new kaspa.XPrv(seed).toString(),
            false,
            0n
          )
        );
      } catch {
        /* that wallet just won't scan derived addresses */
      }
    }
  }

  /** Re-read the account list from the SDK, e.g. after adding a wallet. */
  private async refreshRegistry(password: string): Promise<void> {
    const w = this.wallet;
    if (!w) return;
    try {
      const en = await this.withTimeout(
        w.accountsEnumerate({}),
        10_000,
        "accountsEnumerate-registry"
      );
      const descriptors = (en.accountDescriptors ?? []) as any[];
      if (descriptors.length > 0) {
        this.wallets = this.buildRegistry(descriptors);
        this.derivePubGens(password);
      }
    } catch {
      /* keep the registry we have */
    }
  }

  /**
   * Make another wallet active.
   *
   * Resolves as soon as the LOCAL switch is done. Activating the account starts a UTXO scan that
   * can be slow or stall outright (the whole reason open() backgrounds connectActivateScan), so it
   * is fired off in the background rather than awaited: awaiting it left the import dialog spinning
   * on "Importing…" forever for a wallet that had already been created and made active.
   */
  async selectWallet(accountId: string): Promise<void> {
    if (!this.wallet || !this.isOpen) throw new Error("Wallet is locked.");
    // Same reason as selectReceiveAddress: a money op captured the active address when it started.
    if (this.txInFlight) {
      throw new Error(
        "A transaction or consolidation is in progress. Stop it before switching wallets."
      );
    }
    if (accountId === this._accountId) return;
    if (!this.wallets.some((e) => e.accountId === accountId)) {
      throw new Error("Unknown wallet.");
    }
    let acc = this.descriptorCache.get(accountId);
    if (!acc) {
      // Only if the cache somehow lacks it (never on a normal open → switch path).
      const en = await this.withTimeout(
        this.wallet.accountsEnumerate({}),
        15_000,
        "accountsEnumerate-select"
      );
      const list = (en.accountDescriptors ?? []) as any[];
      for (const d of list) this.descriptorCache.set(String(d.accountId), d);
      acc = this.descriptorCache.get(accountId);
    }
    if (!acc) throw new Error("That wallet is no longer in this file.");
    // Mark the switch BEFORE clearing the balance, so the dashboard can show "loading this
    // wallet" rather than a hard 0 KRX that reads as a wallet with no funds.
    this.switchingWallet = accountId;
    this.adoptAccount(acc);
    this.balance = { mature: 0n, pending: 0n };
    this.emit();
    void this.activateInBackground(accountId);
  }

  /**
   * Bring an account's UtxoContext online, off the UI's critical path. Bounded by a timeout so a
   * stalled scan surfaces as activateError (visible in diagnose()) instead of a promise that never
   * settles; the RPC balance read below still fills the dashboard in either case.
   */
  private async activateInBackground(accountId: string): Promise<void> {
    const w = this.wallet;
    if (!w) return;
    try {
      await this.withTimeout(
        w.accountsActivate({ accountIds: [accountId] }),
        20_000,
        "accountsActivate-select"
      );
      this.activateError = null;
    } catch (e) {
      this.activateError = e instanceof Error ? e.message : String(e);
    }
    this.emit();
    // Only drop the switching flag once the new wallet's balance has actually been read: that is
    // the moment the dashboard stops showing someone else's numbers.
    try {
      await this.refreshBalanceFromUtxos();
    } finally {
      if (this.switchingWallet === accountId) {
        this.switchingWallet = null;
        this.emit();
      }
    }
    void this.refreshWalletTotals();
  }

  /**
   * Sum every wallet's mature balance from the node, for the all-wallets total.
   *
   * Reads balances over RPC rather than activating every account: activation kicks off a UTXO scan
   * per account, and that scan is the historically fragile part of this app (see
   * connectActivateScan). One getBalancesByAddresses call covers every wallet at once.
   */
  async refreshWalletTotals(): Promise<void> {
    if (!this.wallet || this.conn !== "connected" || this.wallets.length === 0) return;
    const perWallet = new Map<string, string[]>();
    const all = new Set<string>();
    for (const entry of this.wallets) {
      const list = new Set<string>();
      const gen = this.pubGens.get(entry.accountId);
      if (gen) {
        try {
          for (const a of gen.receiveAddressAsStrings(this._networkId, 0, TOTALS_DEPTH)) list.add(a);
          for (const a of gen.changeAddressAsStrings(this._networkId, 0, TOTALS_DEPTH)) list.add(a);
        } catch {
          /* fall back to the addresses we already know */
        }
      }
      if (entry.receiveAddress) list.add(entry.receiveAddress);
      if (entry.accountId === this._accountId) {
        for (const a of this.accountAddresses) list.add(a);
      }
      perWallet.set(entry.accountId, [...list]);
      for (const a of list) all.add(a);
    }
    if (all.size === 0) return;
    const bal = new Map<string, bigint>();
    try {
      const res: any = await this.withTimeout(
        this.wallet.rpc.getBalancesByAddresses([...all]),
        8000,
        "getBalancesByAddresses-totals"
      );
      for (const e of (res?.entries ?? []) as Array<{ address?: any; balance?: bigint }>) {
        const ad = e.address?.toString?.() ?? String(e.address ?? "");
        try {
          bal.set(ad, BigInt(e.balance ?? 0n));
        } catch {
          bal.set(ad, 0n);
        }
      }
    } catch {
      return; // node unavailable - keep the previous totals rather than showing zeros
    }
    for (const entry of this.wallets) {
      let sum = 0n;
      for (const a of perWallet.get(entry.accountId) ?? []) sum += bal.get(a) ?? 0n;
      entry.balanceSompi = sum;
    }
    this.emit();
  }

  private readActiveWalletId(): string | null {
    try {
      return localStorage.getItem(ACTIVE_WALLET_KEY);
    } catch {
      return null;
    }
  }

  private writeActiveWalletId(accountId: string): void {
    try {
      localStorage.setItem(ACTIVE_WALLET_KEY, accountId);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Background phase of open(). ORDER MATTERS — proven via live diagnostics: the account is a
   * UtxoContext and its addresses are SCANNED/REGISTERED when the processor (re)connects, but ONLY
   * for accounts that are ALREADY ACTIVE at connect time (kaspa.d.ts:7307-7312 "re-connecting…
   * followed by address re-registration", 7298-7301 trackAddresses=scan+register, 7229 account==
   * UtxoContext). So we MUST activate the account BEFORE connect()+start(). The previous order
   * (connect→start→activate) brought the processor up with NO active context → it scanned nothing,
   * the "balance"/"discovery" events never fired, the context stayed empty, and accountsGetUtxos /
   * accountsSend (consolidate, send) HUNG forever waiting on an empty UTXO source. Activating first
   * makes the connect-time scan run against the live account → discovery/balance fire → context
   * populates → send/consolidate work. The RPC balance fallback stays as a display belt-and-braces.
   */
  private async connectActivateScan(accountId: string): Promise<void> {
    const w = this.wallet;
    if (!w) return;
    this.activateError = null;
    try {
      // 1) Activate FIRST so the account's UtxoContext exists and its addresses are registered
      //    before the processor comes online.
      try {
        await w.accountsActivate({ accountIds: [accountId] });
        this.activateError = null;
      } catch (ae) {
        this.activateError = ae instanceof Error ? ae.message : String(ae);
        this.emit();
      }
      // 2) Connect (resolve only when truly connected), then start the processor → the connect-time
      //    scan runs against the now-active account and emits discovery/balance.
      await w.connect({ blockAsyncConnect: true });
      this.conn = "connected"; // connect() resolved — mark it directly, don't wait for an event
      this.emit();
      await w.start();
      this.scanning = true; // the processor now scans the active account's addresses
      this.emit();
      this.startStatusPoll();
      this.scheduleScanDone();
      this.scheduleBalanceFallback();
    } catch (e) {
      // The wallet stays unlocked; just reflect that we couldn't reach/scan the node.
      if (this.conn !== "connected") this.conn = "disconnected";
      this.scanning = false;
      this.lastError =
        e instanceof Error ? e.message : "Could not connect to the node.";
      this.emit();
      // Even if connect/activate failed, try a direct UTXO read in case RPC is partially up.
      this.scheduleBalanceFallback();
    }
  }

  /** Poll the node's server info (synced + DAA) every few seconds so the UI shows live status. */
  private startStatusPoll() {
    this.stopStatusPoll();
    const tick = async () => {
      try {
        const info = await this.wallet!.rpc.getServerInfo();
        this.synced = info.isSynced;
        this.nodeDaa = info.virtualDaaScore;
        this.hasUtxoIndex = info.hasUtxoIndex;
        if (this.conn !== "connected") this.conn = "connected";
        this.emit();
        // The wallet-core "balance" event does not fire in our integration (confirmed via
        // diagnostics: gotBalanceEvent stays false), so keep the balance live by re-reading it
        // from the node each tick. No-op once/if a real balance event ever lands.
        await this.refreshBalanceFromUtxos();
      } catch {
        /* transient — keep last known values */
      }
    };
    void tick();
    this.pollTimer = setInterval(tick, 5000) as unknown as number;
  }

  private stopStatusPoll() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Stop showing "scanning" after a short grace period even if no balance event arrives
   *  (e.g. an empty wallet may not emit one). A balance event clears it sooner. */
  private scheduleScanDone() {
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanning = false;
      this.emit();
    }, 12000) as unknown as number;
  }

  /** Gather the addresses we know for the account (receive + change + any extras) for the
   *  direct-UTXO balance fallback. Deduped, stringified. */
  private collectDescriptorAddresses(acc: any): string[] {
    const out = new Set<string>();
    const add = (a: any) => {
      if (!a) return;
      try {
        const s = typeof a === "string" ? a : a.toString();
        if (s) out.add(s);
      } catch {
        /* ignore */
      }
    };
    add(acc?.receiveAddress);
    add(acc?.changeAddress);
    if (Array.isArray(acc?.addresses)) acc.addresses.forEach(add);
    return [...out];
  }

  /**
   * Belt-and-suspenders: a little after opening, if no "balance" event has arrived (the initial
   * UTXO scan can race or, on some node builds, not emit for already-mature UTXOs), read the UTXO
   * set directly via accountsGetUtxos and sum it so the balance never gets stuck at 0. A real
   * "balance" event always wins (it classifies mature/pending correctly), so this only fills a gap.
   */
  private scheduleBalanceFallback() {
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => {
      void this.refreshBalanceFromUtxos();
    }, 4000) as unknown as number;
  }

  /**
   * Fallback balance read that does NOT depend on the wallet's internal UTXO scan: ask the NODE
   * directly for the balance of our known addresses via RPC getBalancesByAddresses (needs the node
   * to run with --utxoindex). Public so a manual "Refresh" can call it. A real "balance" event
   * always wins (it classifies mature/pending), so this only fills the gap when the event is late
   * or absent.
   */
  async refreshBalanceFromUtxos(): Promise<void> {
    if (!this.wallet || !this._accountId) return;
    if (this.gotBalanceEvent) return; // the event path is authoritative
    if (this.accountAddresses.length === 0) return;
    try {
      const res = await this.wallet.rpc.getBalancesByAddresses(
        this.activeAddresses()
      );
      const entries = (res?.entries ?? []) as Array<{ balance?: bigint }>;
      let total = 0n;
      for (const e of entries) {
        try {
          total += BigInt(e.balance ?? 0n);
        } catch {
          /* skip */
        }
      }
      if (!this.gotBalanceEvent) {
        // utxoindex balance is the confirmed spendable amount → show as mature.
        this.balance = { mature: total, pending: this.balance.pending };
        this.scanning = false;
        this.emit();
      }
    } catch {
      /* node may lack --utxoindex or reject the call — diagnose() surfaces the reason */
    }
  }

  /**
   * On-demand diagnostics so we can SEE why a balance isn't showing instead of guessing. Returns
   * the node's UTXO-index flag, our known addresses, and the node-reported balance per address.
   * Touches only read-only RPCs; never logs/returns secrets.
   */
  async diagnose(): Promise<{
    connected: boolean;
    synced: boolean | null;
    hasUtxoIndex: boolean | null;
    nodeDaa: string | null;
    gotBalanceEvent: boolean;
    eventCount: number;
    lastEventTypes: string[];
    activateError: string | null;
    accountId: string | null;
    addressCount: number;
    firstAddress: string | null;
    nodeUtxoCount: number;
    accountUtxoCount: number | string;
    perAddress: Array<{ address: string; balanceSompi: string }>;
    totalSompi: string;
    entriesDump: any[];
    entriesDumpError: string | null;
    rpcError: string | null;
  }> {
    const base = {
      connected: this.conn === "connected",
      synced: this.synced,
      hasUtxoIndex: this.hasUtxoIndex,
      nodeDaa: this.nodeDaa != null ? this.nodeDaa.toString() : null,
      gotBalanceEvent: this.gotBalanceEvent,
      eventCount: this.eventCount,
      lastEventTypes: [...this.lastEventTypes],
      activateError: this.activateError,
      accountId: this._accountId,
      addressCount: this.accountAddresses.length,
      firstAddress: this.accountAddresses[0] ?? null,
      nodeUtxoCount: 0,
      accountUtxoCount: "n/a" as number | string,
      perAddress: [] as Array<{ address: string; balanceSompi: string }>,
      totalSompi: "0",
      entriesDump: [] as any[],
      entriesDumpError: null as string | null,
      rpcError: null as string | null,
    };
    if (!this.wallet || this.accountAddresses.length === 0) return base;
    // Dump the RAW node UTXO fields so we can replay createTransactions offline with the exact data.
    try {
      const u = await this.withTimeout(
        this.wallet.rpc.getUtxosByAddresses(this.accountAddresses),
        6000,
        "getUtxosByAddresses-dump"
      );
      const refs = (u?.entries ?? []) as any[];
      base.entriesDump = refs.map((r) => {
        const op = r.outpoint ?? {};
        const spk = r.scriptPublicKey ?? {};
        return {
          address: r.address?.toString?.() ?? String(r.address),
          outTxId: op.transactionId ?? op.getId?.() ?? null,
          outIndex: op.index ?? null,
          amount: String(r.amount),
          spkVersion: spk.version ?? null,
          spkScript: spk.script ?? null,
          spkScriptType: typeof spk.script,
          blockDaaScore: String(r.blockDaaScore),
          isCoinbase: r.isCoinbase ?? null,
        };
      });
    } catch (e) {
      base.entriesDumpError = e instanceof Error ? e.message : String(e);
    }
    try {
      // refresh the utxoindex flag too
      try {
        const info = await this.withTimeout(
          this.wallet.rpc.getServerInfo(),
          6000,
          "getServerInfo"
        );
        base.hasUtxoIndex = info.hasUtxoIndex;
        base.synced = info.isSynced;
      } catch {
        /* keep cached */
      }
      // What the NODE sees for our addresses (read-only).
      const res = await this.withTimeout(
        this.wallet.rpc.getBalancesByAddresses(this.accountAddresses),
        6000,
        "getBalancesByAddresses"
      );
      const entries = (res?.entries ?? []) as Array<{
        address?: any;
        balance?: bigint;
      }>;
      let total = 0n;
      for (const e of entries) {
        let bal = 0n;
        try {
          bal = BigInt(e.balance ?? 0n);
        } catch {
          /* skip */
        }
        total += bal;
        base.perAddress.push({
          address: e.address?.toString?.() ?? String(e.address ?? "?"),
          balanceSompi: bal.toString(),
        });
      }
      base.totalSompi = total.toString();
      try {
        const u = await this.withTimeout(
          this.wallet.rpc.getUtxosByAddresses(this.accountAddresses),
          6000,
          "getUtxosByAddresses"
        );
        base.nodeUtxoCount = (u?.entries ?? []).length;
      } catch {
        /* ignore */
      }
      // What the WALLET-CORE account context sees (this is what accountsSend signs from). If the
      // node shows UTXOs but this is 0 (or this call TIMES OUT), the context never got populated →
      // send/consolidate hang. This is the smoking-gun probe, so it's timeout-guarded.
      if (this._accountId) {
        try {
          const au = await this.withTimeout(
            this.wallet.accountsGetUtxos({
              accountId: this._accountId,
              addresses: this.accountAddresses,
            }),
            6000,
            "accountsGetUtxos"
          );
          base.accountUtxoCount = (au?.utxos ?? []).length;
        } catch (e) {
          base.accountUtxoCount = `error: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      }
    } catch (e) {
      base.rpcError = e instanceof Error ? e.message : String(e);
    }
    return base;
  }

  private async explorerGet(path: string, label: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.withTimeout(
        fetch(`${explorerApiBase(this._networkId)}${path}`),
        10_000,
        label
      );
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      return body && typeof body === "object" && !("error" in body) ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Holder-reward bracket of ONE payout address, from the explorer API. Null when the wallet is
   * closed, disconnected, or the API did not answer; a non-mining address answers with
   * `productionRaw === 0n`.
   */
  async holderRewardFor(address: string): Promise<HolderReward | null> {
    if (!this.wallet || this.conn !== "connected") return null;
    const r = await this.explorerGet(
      `/api/v1/addresses/${encodeURIComponent(address)}/holder-reward`,
      "holder-reward"
    );
    if (!r) return null;
    const productionRaw = r.is_miner ? jsonBig(r.production_24h_sompi) : 0n;
    const next = r.next_bracket as Record<string, unknown> | null | undefined;
    return {
      address,
      virtualDaaScore: jsonBig(r.tip_daa),
      effBalance: jsonBig(r.balance_sompi),
      productionRaw,
      production: productionRaw > 0n ? productionRaw : 1n,
      bracketBps: jsonBig(r.bracket_bps),
      nextBracketBps: next ? jsonBig(next.bps) : null,
      nextBracketBalance: next ? jsonBig(next.target_balance_sompi) : null,
      fullBracketBalance: jsonBig(r.full_bracket_balance_sompi),
      windowDaa: jsonBig(r.window_daa),
      active: true,
      // Income split (paid / burned / escrow / inference / tier mix) is not served yet; the panel
      // hides those rows while `incomeWindowDaa` is 0n.
      paid: 0n,
      burned: 0n,
      escrow: 0n,
      inference: 0n,
      incomeWindowDaa: 0n,
      tierBase: [],
    };
  }

  /**
   * Holder-reward standing of the account: the active receive address first, then the account's
   * other known addresses until one shows production. The winner is remembered in
   * `holderRewardAddress` so later polls are a single call; cleared on account change.
   */
  async holderReward(): Promise<HolderReward | null> {
    if (!this.wallet || this.conn !== "connected") return null;
    if (this.holderRewardAddress) {
      const cached = await this.holderRewardFor(this.holderRewardAddress);
      if (cached && cached.productionRaw > 0n) return cached;
      this.holderRewardAddress = null;
    }
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const a of [this.receiveAddress, ...this.receiveAddresses, ...this.accountAddresses]) {
      if (a && !seen.has(a)) {
        seen.add(a);
        candidates.push(a);
      }
    }
    let first: HolderReward | null = null;
    for (const a of candidates.slice(0, HOLDER_REWARD_SCAN_LIMIT)) {
      const r = await this.holderRewardFor(a);
      if (!r) return first;
      first ??= r;
      if (r.productionRaw > 0n) {
        this.holderRewardAddress = a;
        return r;
      }
    }
    return first;
  }

  /** Service-ledger standing of one payout address, from the explorer API. */
  async serviceStandingFor(address: string): Promise<ServiceStanding | null> {
    if (!this.wallet || this.conn !== "connected") return null;
    const r = await this.explorerGet(
      `/api/v1/addresses/${encodeURIComponent(address)}/service-strikes`,
      "service-strikes"
    );
    if (!r) return null;
    const burns = Array.isArray(r.pending_burns) ? (r.pending_burns as Record<string, unknown>[]) : [];
    const lastStrike = r.last_strike_daa_score;
    const suspended = r.suspended_until_daa_score;
    return {
      consecutiveMisses: Number(r.consecutive_misses ?? 0),
      lastStrikeDaaScore: lastStrike == null ? null : jsonBig(lastStrike),
      suspendedUntilDaaScore: suspended == null ? null : jsonBig(suspended),
      pendingBurnCount: burns.length,
      pendingBurnSompi: burns.reduce((acc, b) => acc + jsonBig(b.burnedSompi ?? b.burned_sompi), 0n),
      lifetimeStrikes: Number(r.lifetime_strikes ?? 0),
    };
  }

  /** Reject after `ms` if a promise hasn't settled — so a hung wallet-core call can't freeze a
   *  diagnostic. The label is surfaced in the thrown message. */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms)
      ),
    ]);
  }

  /**
   * Configure the node endpoint / network. If a wallet is currently open we LOCK it first:
   * stop activity, drop the old connection, and reset balance/address/account — otherwise the
   * UI could keep showing one network's balance/address while sends use another (audit C1).
   * The caller must await this; after it the app returns to the unlock screen.
   */
  async setNode(settings: NodeSettings): Promise<void> {
    if (!this.wasmReady) throw new Error("WASM not initialized");
    const endpoint = `${settings.url}|${settings.networkId}`;
    // Already bound to this endpoint and nothing is open → nothing to rebuild. Boot calls this
    // right after init(), and a double-invoked effect (React StrictMode in dev, or a remount)
    // would otherwise build a second kaspa.Wallet while the first is still alive, which corrupts
    // the shared WASM state.
    if (this.wallet && this.walletEndpoint === endpoint && !this.isOpen) {
      this._networkId = settings.networkId;
      this.nodeSettings = settings;
      return;
    }
    if (this.isOpen) {
      await this.lock();
    }
    this._networkId = settings.networkId;
    this.nodeSettings = settings;
    // lock() already stopped an open wallet, and a closed one was never started: stopping it
    // again never returns.
    this.wallet = null;
    this.buildWallet(settings);
    this.emit();
  }

  /** Lock: stop activity and forget the in-memory account. Storage is untouched. */
  async lock(): Promise<void> {
    const w = this.wallet;
    // A running consolidation would keep submitting into a connection we are about to drop. Ask it
    // to stop and let it finish the transaction in flight — locking mid-submit achieves nothing
    // except an unclear failure.
    if (this.isConsolidating) {
      this.stopConsolidate();
      for (let i = 0; i < 60 && this.isConsolidating; i++) {
        await this.sleep(250);
      }
    }
    this.stopStatusPoll();
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.gotBalanceEvent = false;
    this.accountAddresses = [];
    this._accountId = null;
    this.signingSecret = null;
    this.receiveAddress = null;
    this.receiveAddresses = [];
    this.pubGen = null;
    this.pubGens.clear();
    this.descriptorCache.clear();
    this.wallets = [];
    this.switchingWallet = null;
    this.balance = { mature: 0n, pending: 0n };
    this.conn = "disconnected";
    this.synced = false;
    this.scanning = false;
    this.nodeDaa = null;
    this.hasUtxoIndex = null;
    this.emit();
    if (w) {
      try {
        await w.stop();
      } catch {
        /* ignore */
      }
      try {
        await w.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  getStatus(): WalletStatus {
    return {
      initialized: this.wasmReady,
      addressPrefix: this.addressPrefix,
      conn: this.conn,
      synced: this.synced,
    };
  }

  /**
   * Probe a node endpoint WITHOUT touching the open wallet: opens a throwaway RpcClient, asks
   * getServerInfo, then disconnects. Uses Fallback strategy + a timeout so it never hangs on an
   * unreachable host. Works for local, LAN, or public (ws/wss) nodes.
   */
  async testConnection(
    url: string,
    networkId: string
  ): Promise<{
    ok: boolean;
    synced?: boolean;
    daaScore?: bigint;
    version?: string;
    networkId?: string;
    utxoIndex?: boolean;
    error?: string;
  }> {
    if (!this.wasmReady) throw new Error("WASM not initialized");
    let rpc: kaspa.RpcClient | null = null;
    try {
      rpc = new kaspa.RpcClient({
        url,
        encoding: kaspa.Encoding.Borsh,
        networkId,
      });
      await rpc.connect({
        strategy: kaspa.ConnectStrategy.Fallback,
        timeoutDuration: 8000,
      });
      const info = await rpc.getServerInfo();
      return {
        ok: true,
        synced: info.isSynced,
        daaScore: info.virtualDaaScore,
        version: info.serverVersion,
        networkId: info.networkId,
        utxoIndex: info.hasUtxoIndex,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Could not reach the node.",
      };
    } finally {
      try {
        await rpc?.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  // --- transactions / fees / addresses ---

  /** Per-account incoming deposits (newest first). Records genuine incoming UTXOs (excluding our own
   *  change) to localStorage as they appear, so the list is per-account and persists after spending. */
  async receivedEntries(): Promise<ReceivedEntry[]> {
    await this.syncReceivedLog();
    const active = this.receiveAddress;
    return this.readReceivedLog()
      .filter((e) => (active ? e.address === active : true))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  private async syncReceivedLog(): Promise<void> {
    if (!this.wallet || this.accountAddresses.length === 0) return;
    let entries: any[];
    try {
      entries = await this.fetchEntries();
    } catch {
      return;
    }
    const log = this.readReceivedLog();
    const seen = new Set(log.map((e) => `${e.txid}:${e.index}`));
    const ourTxids = new Set(this.readLocalActivity().map((a) => a.id)); // our sends → change
    let changed = false;
    const now = Date.now();
    for (const e of entries) {
      const txid = String(e.outpoint?.transactionId ?? "");
      if (!txid) continue;
      const index = Number(e.outpoint?.index ?? 0);
      const key = `${txid}:${index}`;
      if (seen.has(key)) continue;
      if (ourTxids.has(txid)) continue; // our own change, not an incoming deposit
      log.push({
        txid,
        index,
        amountSompi: BigInt(e.amount ?? 0n),
        timestamp: now,
        isCoinbase: !!e.isCoinbase,
        address: e.address ? String(e.address) : undefined,
      });
      seen.add(key);
      changed = true;
    }
    if (changed) this.writeReceivedLog(log);
  }

  private readReceivedLog(): ReceivedEntry[] {
    try {
      const raw = localStorage.getItem(RECEIVED_LOG_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as Array<{
        txid: string;
        index: number;
        amountSompi: string;
        timestamp?: number;
        isCoinbase?: boolean;
        address?: string;
      }>;
      return arr.map((e) => ({
        txid: e.txid,
        index: e.index,
        amountSompi: (() => {
          try {
            return BigInt(e.amountSompi);
          } catch {
            return 0n;
          }
        })(),
        timestamp: e.timestamp,
        isCoinbase: e.isCoinbase,
        address: e.address,
      }));
    } catch {
      return [];
    }
  }

  private writeReceivedLog(log: ReceivedEntry[]): void {
    try {
      const serialized = log
        .slice(-500)
        .map((e) => ({ ...e, amountSompi: e.amountSompi.toString() }));
      localStorage.setItem(RECEIVED_LOG_KEY, JSON.stringify(serialized));
    } catch {
      /* localStorage may be unavailable — non-fatal */
    }
  }

  /**
   * Per-account "Sent": our own outgoing txs from the ACTIVE address only. We do NOT use the SDK's
   * transactionsDataGet here — in this integration it returns account-wide records that can't be
   * attributed per address (and is often empty), which made the list not change when switching
   * accounts. Incoming is shown separately via receivedEntries (also per-account).
   */
  async history(limit = 50): Promise<HistoryEntry[]> {
    if (!this.wallet || !this._accountId) return [];
    const active = this.receiveAddress;
    const local = this.readLocalActivity().filter((e) =>
      active ? e.fromAddress === active : true
    );
    local.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return local.slice(0, limit);
  }

  /**
   * Estimate the fee for a send. SDK: accountsEstimate(...) → { generatorSummary }.
   * priorityFeeSompi is required by the request interface; default 0n.
   */
  async estimate(
    destAddress: string,
    amountSompi: bigint,
    priorityFeeSompi: bigint = 0n
  ): Promise<SendEstimate> {
    if (!this.wallet || !this._accountId) {
      throw new Error("Wallet is locked.");
    }
    // SYNC estimate. The async Generator (accountsEstimate/estimateTransactions) HANGS in the
    // webview's wasm executor (same as createTransactions), so we size the tx with the SYNCHRONOUS
    // createTransaction + calculateTransactionFee. kaspa.d.ts: createTransaction 174,
    // calculateTransactionFee 73. No keys needed for a fee estimate.
    const all = await this.fetchEntries();
    if (all.length === 0) throw new Error("No spendable UTXOs found.");
    const entries = all.slice(0, WalletService.MAX_TX_INPUTS);
    const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
    if (!changeAddress) throw new Error("No change address available.");
    const total: bigint = entries.reduce(
      (s: bigint, e: any) => s + BigInt(e.amount),
      0n
    );
    // Stay consistent with send(): don't quote a fee for an amount send() will then refuse. If the
    // largest MAX_TX_INPUTS UTXOs can't fund the amount but more UTXOs exist, the answer is to
    // consolidate first — surface that here instead of clamping sent=total and returning a fee.
    if (amountSompi > total) {
      if (all.length > entries.length) {
        throw new Error(
          `This amount needs more than ${WalletService.MAX_TX_INPUTS} UTXOs in one transaction. ` +
            `Consolidate your funds first, then send.`
        );
      }
      throw new Error("Amount exceeds your spendable balance.");
    }
    const sent: bigint = amountSompi;
    const change: bigint = total - sent;
    const outs: { address: string; amount: bigint }[] = [
      { address: destAddress, amount: sent },
    ];
    if (change > 0n) outs.push({ address: changeAddress, amount: change });
    const tx = kaspa.createTransaction(entries as any, outs as any, 0n);
    const massFee = (kaspa.calculateTransactionFee(this._networkId, tx) ?? 0n) as bigint;
    const minFee =
      BigInt(massFee) > WalletService.KERYX_MIN_FEE
        ? BigInt(massFee)
        : WalletService.KERYX_MIN_FEE;
    const feeSompi = minFee + priorityFeeSompi;
    const totalSompi = amountSompi + feeSompi;
    return { feeSompi, totalSompi };
  }

  /** Current fee-rate estimate buckets. SDK: feeRateEstimate() → {priority,normal,low}. */
  async feeRate() {
    if (!this.wallet) throw new Error("Wallet not ready.");
    return await this.wallet.feeRateEstimate({});
  }


  /**
   * Send funds, signed with the secret held for the unlocked session.
   * Returns the submitted transaction ids.
   */
  async send(
    destAddress: string,
    amountSompi: bigint,
    priorityFeeSompi: bigint = 0n
  ): Promise<string[]> {
    const password = this.requireSigningSecret();
    // The high-level accountsSend hangs in our integration because the account UtxoContext never
    // populates. We build/sign/submit the tx ourselves from node-reported UTXOs + derived keys.
    return this.sendManual(password, destAddress, amountSompi, priorityFeeSompi);
  }

  /**
   * Consolidate (compound) UTXOs: spends your many small UTXOs back to your own change address,
   * compounding the WHOLE set into a single UTXO. One tx caps at MAX_TX_INPUTS inputs, so the manual
   * path AUTO-LOOPS batch-by-batch (waiting for each to confirm) until ≤1 UTXO remains — see
   * consolidateManual. `onProgress` fires after each confirmed batch. Returns the batch txids.
   */
  async consolidate(
    onProgress?: (info: ConsolidateProgress) => void,
    maxFeeSompi?: bigint
  ): Promise<string[]> {
    const password = this.requireSigningSecret();
    // Same reason as send(): bypass the empty UtxoContext and sweep via the manual path.
    // maxFeeSompi = the fee the user accepted in the UI; the run never exceeds it.
    return this.consolidateManual(password, onProgress, maxFeeSompi);
  }

  // =====================================================================
  // CONTEXT-FREE (manual) send + consolidate
  //
  // These bypass the high-level account UtxoContext entirely. They pull
  // UTXOs straight from the node via rpc.getUtxosByAddresses, derive the
  // matching private keys from the (decrypted) mnemonic, then build / sign
  // / submit with the low-level kaspa.createTransactions Generator.
  //
  // Use these when accountsSend hangs because the account's UtxoContext is
  // empty even though the node reports UTXOs on the receive address.
  //
  // CRITICAL derivation assumption (verify at runtime — see verifyDerivation):
  //   The account was created with accountsCreate({type:"bip32"}). The
  //   canonical helpers PrivateKeyGenerator / PublicKeyGenerator.fromMasterXPrv
  //   reproduce the EXACT same receive/change addresses as that account, as
  //   long as we pass the same (account_index=0, is_multisig=false) params.
  //   The coin type / purpose / hardening of the path live inside the WASM
  //   and are NOT visible in the JS source, so they cannot be asserted from
  //   the .d.ts alone — they must be checked against a known funded address.
  // =====================================================================

  /** Minimum receive/change indices to derive when building the key map. */
  private static readonly MANUAL_SCAN_DEPTH = 20;
  /** Hard cap on how deep deriveKeyMap will go while covering known addresses (backstop against an
   *  unexpectedly huge / malformed accountAddresses set). 1000 indices = 2000 keys, derived only
   *  when the wallet has actually rotated that far. */
  private static readonly MAX_SCAN_DEPTH = 1000;
  /** Max inputs per transaction. A P2PK input is ~1100 mass and the standard cap is ~100k, so ~84
   *  inputs fit; stay safely under. Consolidating >this many UTXOs takes several runs. */
  private static readonly MAX_TX_INPUTS = 80;
  // Coinbase (mining-reward) UTXOs can't be spent until this many DAA have passed; the node
  // rejects a tx that spends an immature one ("coinbase maturity ... hasn't passed yet"). The
  // value is Keryx's coinbase maturity, taken from the node's own rejection message; ideally
  // read from INetworkParams later.
  private static readonly COINBASE_MATURITY = 1000n;
  /**
   * Minimum DAA age for a NON-coinbase UTXO before we will spend it.
   *
   * Why this exists: consolidation creates a compound output and the very next batch used to spend
   * it seconds later, which the node rejects with "one of the transaction sequence locks conditions
   * was not met" — Kaspa applies a maturity window to ordinary transaction outputs too, not just to
   * coinbase (the SDK exposes the same notion via UtxoProcessor.setUserTransactionMaturityDAA,
   * kaspa.d.ts:7451). Filtering only coinbase let our own freshest output straight back in as an
   * input, and the largest-first ordering guaranteed it was input #1.
   */
  private static readonly USER_TX_MATURITY = 16n;
  /** Ceiling for the adaptive escalation below — refuse to wait absurdly long on a bad guess. */
  private static readonly MAX_ADAPTIVE_MATURITY = 4096n;

  // Effective maturity floors for THIS session. Not static: the node's real values are not readable
  // through the SDK (it only exposes setters), so on a maturity/sequence-lock rejection we raise
  // these and retry instead of failing on a hardcoded guess.
  private coinbaseMaturity = WalletService.COINBASE_MATURITY;
  private userTxMaturity = WalletService.USER_TX_MATURITY;

  /** Ceiling for coinbase-floor escalation (the base 1000 came from the node's own message). */
  private static readonly MAX_ADAPTIVE_COINBASE_MATURITY = 16384n;

  /**
   * Raise a maturity floor after the node rejected a tx for an immaturity/sequence-lock reason.
   * Escalates the knob the node actually complained about: doubling the user-tx floor on a
   * coinbase rejection would add pointless between-round waits without fixing anything. Doubling
   * converges in a few steps and is bounded; returns false when already at the ceiling so the
   * caller reports the real error instead of looping.
   */
  private escalateMaturity(rejectionMsg: string): boolean {
    if (/coinbase/i.test(rejectionMsg)) {
      if (this.coinbaseMaturity >= WalletService.MAX_ADAPTIVE_COINBASE_MATURITY) return false;
      this.coinbaseMaturity = this.coinbaseMaturity * 2n;
      if (this.coinbaseMaturity > WalletService.MAX_ADAPTIVE_COINBASE_MATURITY) {
        this.coinbaseMaturity = WalletService.MAX_ADAPTIVE_COINBASE_MATURITY;
      }
      return true;
    }
    if (this.userTxMaturity >= WalletService.MAX_ADAPTIVE_MATURITY) return false;
    this.userTxMaturity = this.userTxMaturity * 2n;
    if (this.userTxMaturity > WalletService.MAX_ADAPTIVE_MATURITY) {
      this.userTxMaturity = WalletService.MAX_ADAPTIVE_MATURITY;
    }
    return true;
  }

  /** True when a node rejection is about an input not being spendable YET (vs a real failure). */
  private static isMaturityRejection(msg: string): boolean {
    return /sequence lock|immature|maturity|not.{0,12}mature/i.test(msg);
  }

  /** Backstop for the consolidate round loop. Each round divides the set by ~MAX_TX_INPUTS, so even
   *  250k UTXOs finish in 3 rounds; this only trips if the set inexplicably fails to shrink. */
  private static readonly MAX_CONSOLIDATE_ROUNDS = 12;
  /** Safety cap on transactions per run, so a pathological set can't fire off unbounded txs (each
   *  one costs KERYX_MIN_FEE). 250k UTXOs needs ~3.1k txs, so this leaves real headroom. */
  private static readonly MAX_CONSOLIDATE_TXS = 6000;
  /** Concurrent submits in flight. Enough to keep the node busy without burying its RPC queue. */
  private static readonly SUBMIT_CONCURRENCY = 8;
  /** A getUtxosByAddresses over a huge set is slow but must not hang forever. */
  private static readonly UTXO_FETCH_TIMEOUT_MS = 90000;
  /** Submit timeout. The old 20s default was too tight under the load of a large consolidation. */
  private static readonly SUBMIT_TIMEOUT_MS = 60000;
  /** Keryx's minimum relay fee (sompi). The node rejects txs paying less than this regardless of
   *  size (≈0.3 KRX, anti-spam) — far above Kaspa's mass-based minimum. */
  private static readonly KERYX_MIN_FEE = 30000000n;

  /**
   * Derive an address(string) -> kaspa.PrivateKey map covering receive[0..K]
   * and change[0..K] for the standard bip32 account (account index 0).
   *
   * Grounding (kaspa.d.ts):
   *   - Mnemonic(phrase)               5664
   *   - Mnemonic.toSeed(password?)     5665  -> hex seed string
   *   - new XPrv(seed: HexString)      7860  -> master kprv
   *   - PrivateKeyGenerator(           6061
   *       xprv, is_multisig=false, account_index=0n)
   *       .receiveKey(i) / .changeKey(i) 6059-6060 -> PrivateKey
   *   - PrivateKey.toAddress(networkId) 6023 -> Address
   *
   * NOTE: keys live only in this local Map; the mnemonic string is read once
   * and never logged or stored. Caller is responsible for not retaining the
   * returned map longer than needed.
   */
  private deriveKeyMap(
    password: string,
    depth = WalletService.MANUAL_SCAN_DEPTH
  ): Map<string, kaspa.PrivateKey> {
    if (!this.wasmReady) throw new Error("WASM not initialized");
    const phrase = this.revealMnemonic(password); // throws "Wrong password." on bad pw
    const mnemonic = new kaspa.Mnemonic(phrase);
    const seed = mnemonic.toSeed(); // hex string; no bip39 passphrase
    const xprv = new kaspa.XPrv(seed); // master kprv
    // Pass the xprv as a STRING (not the instance): PrivateKeyGenerator's arg is `XPrv | string`
    // and the WASM union-coercion rejects an XPrv instance ("Invalid XPrv …"); the string form
    // round-trips through the SDK's own (de)serialization.
    // is_multisig=false, account_index=0n, cosigner_index=undefined
    const gen = new kaspa.PrivateKeyGenerator(xprv.toString(), false, 0n);

    const map = new Map<string, kaspa.PrivateKey>();
    // We must be able to sign a UTXO on ANY address the node may report for us, and fetchEntries
    // queries exactly this.accountAddresses (receive/change + every rotated "new" receive address).
    // A FIXED depth therefore leaves high-index addresses (heavy new-address rotation) unsignable —
    // their UTXOs get fetched, sorted largest-first into the tx, then fail at sign/submit. So derive
    // at least `depth`, then keep going until every known account address is covered, capped at
    // MAX_SCAN_DEPTH.
    const stillNeeded = new Set(this.accountAddresses);
    for (
      let i = 0;
      (i < depth || stillNeeded.size > 0) && i < WalletService.MAX_SCAN_DEPTH;
      i++
    ) {
      const rk = gen.receiveKey(i);
      const ra = rk.toAddress(this._networkId).toString();
      map.set(ra, rk);
      stillNeeded.delete(ra);
      const ck = gen.changeKey(i);
      const ca = ck.toAddress(this._networkId).toString();
      map.set(ca, ck);
      stillNeeded.delete(ca);
    }
    return map;
  }

  /**
   * SAFETY GATE for the manual tx path. Reuses the already-derived key map (no extra mnemonic
   * reveal): if our known receive address isn't reproduced by the derivation, the keys are wrong
   * and we MUST NOT sign — abort loudly instead of broadcasting an invalid/garbage transaction.
   */
  private assertDerivationMatches(keyMap: Map<string, kaspa.PrivateKey>): void {
    // Derivation-correctness probe: if our PRIMARY receive address isn't reproduced by the
    // derivation, the path params (coin type / account index / multisig) are wrong and every key is
    // wrong — abort before signing. (Per-UTXO coverage of the specific addresses we're about to
    // spend is enforced separately by assertEntriesCovered.)
    const probe = this.receiveAddress ?? this.accountAddresses[0];
    if (probe && !keyMap.has(probe)) {
      throw new Error(
        "Key derivation does not match this wallet's addresses. Aborting to avoid signing with " +
          "the wrong keys. (Manual transaction path disabled for safety.)"
      );
    }
  }

  /**
   * SAFETY GATE: every UTXO we're about to spend must have a derived signing key in `keyMap`, or
   * signTransaction would leave an unsigned input and the node would reject the whole tx at submit.
   * With deriveKeyMap now covering all known addresses this should never trip, but if a UTXO ever
   * lands on an address beyond MAX_SCAN_DEPTH we abort BEFORE signing with an honest message instead
   * of building a doomed transaction.
   */
  private assertEntriesCovered(
    entries: any[],
    keyMap: Map<string, kaspa.PrivateKey>
  ): void {
    const uncovered = entries.filter((e) => !keyMap.has(e.address));
    if (uncovered.length > 0) {
      throw new Error(
        `${uncovered.length} of your UTXOs are on addresses this wallet cannot derive a signing ` +
          `key for. Aborting to avoid building an unspendable transaction.`
      );
    }
  }

  /**
   * RUNTIME SELF-CHECK. Returns true iff the derived receive[0] address equals
   * this.receiveAddress (the address the high-level bip32 account exposes and
   * that the node reports as funded). If this returns false, the derivation
   * params (coin type / account index / multisig) do NOT match the account and
   * the manual methods MUST NOT be used — they would derive keys for the wrong
   * addresses and the built tx would fail to sign / be invalid.
   *
   * Call this once after open() before offering manual send/consolidate.
   */
  verifyDerivation(password: string): {
    ok: boolean;
    derived: string;
    expected: string | null;
  } {
    const phrase = this.revealMnemonic(password);
    const xprv = new kaspa.XPrv(new kaspa.Mnemonic(phrase).toSeed());
    // Pass the xprv as a STRING: PrivateKeyGenerator's first arg is `XPrv | string`, and the
    // WASM union-coercion rejects an XPrv *instance* ("Invalid XPrv …"); the string round-trips.
    const gen = new kaspa.PrivateKeyGenerator(xprv.toString(), false, 0n);
    const derived = gen
      .receiveKey(0)
      .toAddress(this._networkId)
      .toString();
    return {
      ok: !!this.receiveAddress && derived === this.receiveAddress,
      derived,
      expected: this.receiveAddress,
    };
  }

  /**
   * Fetch the live UTXO set for our addresses straight from the node.
   * kaspa.d.ts: rpc.getUtxosByAddresses(string[]) 6568
   *   -> IGetUtxosByAddressesResponse { entries: UtxoEntryReference[] }  1525-1526
   * IMPORTANT: we CONVERT each UtxoEntryReference (a wasm class object) into a fully PLAIN
   * IUtxoEntry literal before handing it to createTransactions. Passing the raw wasm
   * UtxoEntryReference[] makes kaspa.createTransactions HANG in the packaged build (a wasm-bindgen
   * ownership/borrow quirk — plain objects work instantly, validated in the Node harness). Plain
   * shape: { address(str), outpoint{transactionId,index}, amount, scriptPublicKey{version,script},
   * blockDaaScore, isCoinbase }. kaspa.d.ts: IUtxoEntry 853, TransactionOutpoint 7075 (transactionId
   * /index), ScriptPublicKey 6917 (version/script). entries accepts IUtxoEntry[] (2343).
   */
  /** The address the wallet currently OPERATES on. In the per-account model this is just the active
   *  (selected) receive address, so balance, sends and history are scoped to that one account. */
  private activeAddresses(): string[] {
    const a = this.receiveAddress ?? this.accountAddresses[0];
    return a ? [a] : [];
  }

  /**
   * @param forConsolidation consolidation mode: an unknown virtual DAA becomes a hard error
   *        instead of silently disabling the maturity filter (a consolidation that skipped it
   *        would spend its own fresh output and be rejected — better to say so than to burn a
   *        fee), AND the user-tx age floor is applied on top of the coinbase one. Sends and
   *        estimates keep coinbase-only filtering: the user-tx floor exists to stop a
   *        consolidation round from spending its OWN seconds-old compound output, and applying
   *        a session-escalated floor to sends would silently hide freshly received funds.
   */
  private async fetchEntries(forConsolidation = false): Promise<any[]> {
    if (!this.wallet) throw new Error("Wallet is locked.");
    const scan = this.activeAddresses();
    if (scan.length === 0) {
      throw new Error("No active address to scan for UTXOs.");
    }
    // Time-boxed: a wallet with hundreds of thousands of UTXOs makes this response huge, and an
    // unguarded call here was one of the reported "RPC request timeout" hangs.
    const res = await this.withTimeout(
      this.wallet.rpc.getUtxosByAddresses(scan),
      WalletService.UTXO_FETCH_TIMEOUT_MS,
      "utxo-fetch"
    );
    const refs = (res?.entries ?? []) as any[];
    const mapped = refs.map((r) => {
      const op = r.outpoint ?? {};
      const spk = r.scriptPublicKey ?? {};
      return {
        address: r.address?.toString?.() ?? String(r.address),
        outpoint: {
          transactionId: op.transactionId ?? op.getId?.(),
          index: Number(op.index ?? 0),
        },
        amount: BigInt(r.amount ?? 0n),
        scriptPublicKey: { version: spk.version, script: spk.script },
        blockDaaScore: BigInt(r.blockDaaScore ?? 0n),
        isCoinbase: !!r.isCoinbase,
      };
    });
    // Skip UTXOs the node will not let us spend YET. Coinbase (mining reward) has a long maturity;
    // ordinary outputs have a shorter one, but it is NOT zero — spending our own seconds-old
    // consolidation output is exactly what produced "one of the transaction sequence locks
    // conditions was not met". Both floors are session values that escalate on such a rejection.
    let daa = this.nodeDaa;
    if (daa == null) {
      try {
        const info = await this.wallet.rpc.getServerInfo();
        daa = info.virtualDaaScore;
        this.nodeDaa = daa;
      } catch {
        /* handled below */
      }
    }
    if (daa == null && forConsolidation) {
      throw new Error(
        "Could not read the node's DAA score, so UTXO maturity cannot be checked. " +
          "Wait for the node to respond and try again."
      );
    }
    const spendable =
      daa != null
        ? mapped.filter((e) => {
            const age = daa - e.blockDaaScore;
            if (e.isCoinbase) return age >= this.coinbaseMaturity;
            return !forConsolidation || age >= this.userTxMaturity;
          })
        : mapped;
    // Spend the LARGEST UTXOs first. A send/estimate is capped at MAX_TX_INPUTS inputs per tx, so
    // taking the node's arbitrary order could slice off dust and fail to fund a send that is well
    // within the real balance. Largest-first guarantees one tx funds the maximum possible amount.
    spendable.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
    return spendable;
  }

  /**
   * Cheap sibling of fetchEntries for the between-rounds wait: only the outpoint keys and the count
   * are needed there. Skips the per-entry object mapping, the BigInt conversions, the maturity
   * filter and the sort — on a 250k-UTXO wallet that work dominated the poll loop.
   */
  private async fetchOutpointKeys(): Promise<Set<string>> {
    if (!this.wallet) throw new Error("Wallet is locked.");
    const scan = this.activeAddresses();
    if (scan.length === 0) return new Set();
    const res = await this.withTimeout(
      this.wallet.rpc.getUtxosByAddresses(scan),
      WalletService.UTXO_FETCH_TIMEOUT_MS,
      "utxo-fetch"
    );
    const out = new Set<string>();
    for (const r of (res?.entries ?? []) as any[]) {
      const op = r.outpoint ?? {};
      out.add(`${op.transactionId ?? op.getId?.() ?? ""}:${Number(op.index ?? 0)}`);
    }
    return out;
  }

  /**
   * CONTEXT-FREE send. Builds, signs and submits without the account UtxoContext.
   *
   * Generator settings (kaspa.d.ts IGeneratorSettingsObject 2303):
   *   - entries: UtxoEntryReference[] from the node (2343)
   *   - outputs: [{ address, amount }]   (2309 / IPaymentOutput 4015)
   *   - changeAddress: our receive[0]    (2313)
   *   - priorityFee: bigint  (2337) — REQUIRED for outbound tx, even if 0n (2329-2330)
   *   - networkId: required because entries is an array (2367)
   *
   * createTransactions(settings) 187 -> ICreateTransactions { transactions[], summary } 4054.
   * We iterate transactions in order, sign+submit each (batching handled by the SDK).
   */
  async sendManual(
    password: string,
    destAddress: string,
    amountSompi: bigint,
    priorityFeeSompi: bigint = 0n
  ): Promise<string[]> {
    if (!this.wallet || !this._accountId) throw new Error("Wallet is locked.");
    // Require a SYNCED node, same as consolidate: against an un-synced node fetchEntries reads a
    // stale UTXO set, so the tx could be built over already-spent inputs (submit fails) or with
    // wrong change math. Send is the higher-stakes op — gate it at least as strictly as consolidate.
    if (this.conn !== "connected" || !this.synced) {
      throw new Error("Connect to a synced node first.");
    }
    if (!this.validateAddress(destAddress)) {
      throw new Error("Invalid destination address.");
    }
    // Serialize money ops: a send and a consolidate (or two sends) running at once would build over
    // the same UTXO set and the second tx would be rejected at submit. No fund loss, but avoid it.
    if (this.txInFlight) {
      throw new Error("Another transaction is already in progress. Please wait.");
    }
    this.txInFlight = true;
    try {
      const keyMap = this.deriveKeyMap(password);
      this.assertDerivationMatches(keyMap);
      const keys = Array.from(keyMap.values());
      const entries = await this.fetchEntries();
      if (entries.length === 0) throw new Error("No spendable UTXOs found.");
      // Every UTXO that will go into the tx must be signable (the largest MAX_TX_INPUTS are used).
      this.assertEntriesCovered(
        entries.slice(0, WalletService.MAX_TX_INPUTS),
        keyMap
      );

      const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
      if (!changeAddress) throw new Error("No change address available.");

      const txid = await this.buildSignSubmitSync(
        entries,
        changeAddress,
        [{ address: destAddress, amount: amountSompi }],
        keys,
        priorityFeeSompi
      );
      this.recordLocalActivity({
        id: txid,
        type: "outgoing",
        direction: "out",
        amountSompi,
        timestamp: Date.now(),
        fromAddress: this.receiveAddress ?? undefined,
      });
      return [txid];
    } finally {
      this.txInFlight = false;
    }
  }

  /**
   * Sign the H6 escrow delegation for a miner: a Schnorr signature by the active receive
   * address's key over blake2b-256(domain || escrow_pubkey). The miner passes the 128-hex
   * result as `--escrow-cert`; from H6 a block without a valid key/cert pair is invalid.
   */
  signEscrowDelegation(escrowPubkeyHex: string): { cert: string; address: string } {
    if (!this.isOpen) throw new Error("Open the wallet first.");
    const password = this.requireSigningSecret();
    const escrowPubkey = escrowPubkeyHex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(escrowPubkey)) {
      throw new Error("The escrow key must be 64 hex characters — copy the line the miner prints at startup.");
    }
    const address = this.receiveAddress;
    if (!address) throw new Error("No receive address available.");
    const keyMap = this.deriveKeyMap(password); // throws "Wrong password." on bad pw
    const key = keyMap.get(address);
    if (!key) throw new Error("The active receive address is not derivable from this wallet.");
    const message = blake2b
      .create({ dkLen: 32 })
      .update(new TextEncoder().encode(ESCROW_DELEGATION_DOMAIN))
      .update(hexToBytes(escrowPubkey))
      .digest();
    // signScriptHash takes the hash as hex and returns a 66-byte signature script:
    // 0x41, the 64 Schnorr bytes, SigHash.
    const messageHex = Array.from(message, (b) => b.toString(16).padStart(2, "0")).join("");
    const sigScript = kaspa.signScriptHash(messageHex, key);
    if (sigScript.length !== 132) throw new Error("Unexpected signature length from the SDK.");
    return { cert: sigScript.slice(2, 130), address };
  }

  /**
   * Submit an AI inference request (subnetwork 0x03) via the manual path.
   *
   * Funds the request from the account's UTXOs and builds the AiRequest with
   * lib/aiRequest.buildAiRequestTx: output[0] change → self, output[1] the
   * keyless reward vault (value = inference_reward, minted to the first accepted
   * responder). Requests are public: they show on the inference livefeed.
   * Signs with the derived keys and broadcasts over wRPC. Returns the request tx
   * id; the answer lands later as an on-chain AiResponse (poll separately).
   *
   * The reward/fee are computed from the node-enforced minimums for the model.
   */
  async submitInference(
    req: {
      model: ModelName;
      prompt: string;
      maxTokens: number;
      priorityFeeSompi?: bigint;
    },
  ): Promise<{
    txId: string;
    rewardSompi: bigint;
    feeSompi: bigint;
    requestHashHex: string;
    cursorHash: string;
  }> {
    if (!this.wallet || !this._accountId) throw new Error("Wallet is locked.");
    const password = this.requireSigningSecret();
    if (this.conn !== "connected" || !this.synced) {
      throw new Error("Connect to a synced node first.");
    }
    if (!req.prompt.trim()) throw new Error("Empty prompt.");
    if (this.txInFlight) {
      throw new Error("Another transaction is already in progress. Please wait.");
    }
    this.txInFlight = true;
    try {
      const rewardSompi = computeInferenceReward(
        MODELS[req.model].baseRewardSompi,
        req.maxTokens,
      );
      const feeSompi =
        req.priorityFeeSompi && req.priorityFeeSompi > MIN_AI_REQUEST_PRIORITY_FEE
          ? req.priorityFeeSompi
          : MIN_AI_REQUEST_PRIORITY_FEE;

      // Capture the current sink as the forward-scan cursor for the answer.
      const dag = await this.wallet.rpc.getBlockDagInfo();
      const cursorHash = (dag as { sink?: string })?.sink ?? "";

      const keyMap = this.deriveKeyMap(password);
      this.assertDerivationMatches(keyMap);
      const signers = Array.from(keyMap.values()).map((k) => k.toString());

      const entries = await this.fetchEntries();
      if (entries.length === 0) throw new Error("No spendable UTXOs found.");
      const used = entries.slice(0, WalletService.MAX_TX_INPUTS);
      this.assertEntriesCovered(used, keyMap);

      const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
      if (!changeAddress) throw new Error("No change address available.");

      const utxos: RequestUtxo[] = used.map((e) => ({
        transactionId: String(e.outpoint.transactionId),
        index: Number(e.outpoint.index),
        amountSompi: BigInt(e.amount),
        scriptPublicKey: {
          version: e.scriptPublicKey.version,
          script: e.scriptPublicKey.script,
        },
        blockDaaScore: BigInt(e.blockDaaScore ?? 0),
        isCoinbase: !!e.isCoinbase,
      }));

      const tx = this.stageSync("build", () =>
        buildAiRequestTx(kaspa as never, {
          utxos,
          changeAddress,
          modelId: MODELS[req.model].modelIdHex,
          prompt: req.prompt,
          maxTokens: req.maxTokens,
          inferenceReward: rewardSompi,
          priorityFee: feeSompi,
          currentDaaScore: this.nodeDaa ?? 0n,
          isPrivate: false,
        }),
      );
      // Keys as HEX STRINGS, not PrivateKey instances (packaged-build wasm-bindgen quirk).
      const signed = this.stageSync("sign", () =>
        kaspa.signTransaction(tx as never, signers as never, true),
      );
      const res = await this.stage("submit", () =>
        this.wallet!.rpc.submitTransaction({ transaction: signed as never }),
      );
      const txId = res?.transactionId ?? "";
      // The on-chain AiResponse references this request by its transaction id.
      const requestHashHex = txId.toLowerCase();
      // Mark our own change so the received-log doesn't count it as a deposit.
      this.recordLocalActivity({
        id: txId,
        type: "outgoing",
        direction: "out",
        amountSompi: feeSompi + rewardSompi,
        timestamp: Date.now(),
        fromAddress: this.receiveAddress ?? undefined,
      });
      return { txId, rewardSompi, feeSompi, requestHashHex, cursorHash };
    } finally {
      this.txInFlight = false;
    }
  }

  /**
   * Look for the on-chain AiResponse answering `requestHashHex` (subnetwork 0x04)
   * by scanning forward from `cursorHash` over wRPC (getBlocks). Returns the IPFS
   * result CID + gateway URL once found, and an advanced cursor to resume from on
   * the next poll. wRPC-only — the answer TEXT itself lives on IPFS (open the URL).
   */
  async pollInferenceResult(
    requestHashHex: string,
    cursorHash: string,
    opts: { maxPages?: number } = {},
  ): Promise<{ result: { cidV0: string; url: string } | null; cursorHash: string }> {
    if (!this.wallet) throw new Error("Wallet is locked.");
    const maxPages = opts.maxPages ?? 4;
    const target = requestHashHex.toLowerCase();
    let cursor = cursorHash;
    for (let page = 0; page < maxPages; page++) {
      let res: any;
      try {
        res = await this.wallet.rpc.getBlocks({
          lowHash: cursor || undefined,
          includeBlocks: true,
          includeTransactions: true,
        });
      } catch {
        break;
      }
      const blocks: any[] = res?.blocks ?? [];
      const hashes: string[] = res?.blockHashes ?? [];
      for (const b of blocks) {
        for (const tx of b.transactions ?? []) {
          if (tx.subnetworkId !== SUBNETWORK_ID_AI_RESPONSE_HEX) continue;
          const parsed = parseAiResponse(tx.payload);
          if (parsed && parsed.requestHashHex.toLowerCase() === target) {
            return {
              result: { cidV0: parsed.cidV0, url: ipfsUrl(parsed.cidV0) },
              cursorHash: cursor,
            };
          }
        }
      }
      const last = hashes[hashes.length - 1];
      if (!last || last === cursor) break; // caught up to the tip
      cursor = last;
    }
    return { result: null, cursorHash: cursor };
  }

  // model_id(hex) -> recently-seen escrow pubkeys, cached to avoid re-walking.
  private capsCache = new Map<string, { pubkeys: string[]; ts: number }>();
  private static readonly CAPS_TTL_MS = 5 * 60 * 1000;
  private static readonly CAPS_SCAN_MAX_BLOCKS = 200;

  /**
   * Find escrow pubkeys of miners currently serving `modelIdHex` (a non-empty
   * list means the model has an active provider). Walks the selected chain backward from the sink
   * over wRPC (getBlockDagInfo + getBlock) and parses each coinbase's /ai:cap: +
   * /escrow: fields (lib/aiCaps) — NO keryx-api / HTTP. Stops early once `want`
   * distinct pubkeys are found; cached for CAPS_TTL_MS. Returns [] if none appear
   * within the scan window (⇒ no active provider for that model right now).
   */
  async fetchModelEscrowPubkeys(
    modelIdHex: string,
    opts: { maxBlocks?: number; want?: number } = {},
  ): Promise<string[]> {
    if (!this.wallet) throw new Error("Wallet is locked.");
    if (this.conn !== "connected" || !this.synced) {
      throw new Error("Connect to a synced node first.");
    }
    const key = modelIdHex.toLowerCase();
    const cached = this.capsCache.get(key);
    if (cached && Date.now() - cached.ts < WalletService.CAPS_TTL_MS) {
      return cached.pubkeys;
    }
    const maxBlocks = opts.maxBlocks ?? WalletService.CAPS_SCAN_MAX_BLOCKS;
    const want = opts.want ?? 5;

    const dag = await this.wallet.rpc.getBlockDagInfo();
    let hash: string | undefined = (dag as { sink?: string })?.sink;
    const found = new Set<string>();
    for (let i = 0; i < maxBlocks && hash && found.size < want; i++) {
      let block: any;
      try {
        const res: any = await this.wallet.rpc.getBlock({
          hash,
          includeTransactions: true,
        });
        block = res?.block ?? res;
      } catch {
        break; // pruned past this point or transient — keep what we have
      }
      if (!block) break;
      const payloadHex: string | undefined = block.transactions?.[0]?.payload;
      if (payloadHex) {
        const pk = escrowForModel(payloadHex, key);
        if (pk) found.add(pk);
      }
      hash =
        block.verboseData?.selectedParentHash ??
        block.header?.parentsByLevel?.[0]?.[0];
    }
    const pubkeys = Array.from(found);
    this.capsCache.set(key, { pubkeys, ts: Date.now() });
    return pubkeys;
  }

  /**
   * Build (SYNCHRONOUSLY), sign and submit one transaction WITHOUT the async Generator. The async
   * Generator (createTransactions/estimateTransactions) HANGS in the webview's wasm executor, so we
   * use the synchronous primitives: createTransaction (174) builds a tx with explicit inputs/outputs,
   * calculateTransactionFee (73) gives the mass-based minimum, signTransaction (226) signs, and we
   * submit via the node RPC. `targetOutputs` are the explicit non-change outputs (empty = pure
   * consolidate/sweep); a change output back to `changeAddress` carries the remainder minus fee.
   * Caps inputs at MAX_TX_INPUTS (one tx's mass); consolidating more takes several runs.
   */
  private async buildSignSubmitSync(
    entries: any[],
    changeAddress: string,
    targetOutputs: { address: string; amount: bigint }[],
    keys: kaspa.PrivateKey[],
    extraFee: bigint
  ): Promise<string> {
    const used = entries.slice(0, WalletService.MAX_TX_INPUTS);
    const total = used.reduce((s, e) => s + BigInt(e.amount), 0n);
    const sent = targetOutputs.reduce((s, o) => s + o.amount, 0n);
    if (sent > total) {
      // entries are largest-first (fetchEntries), so the MAX_TX_INPUTS we kept are the largest
      // possible single-tx funding set. If they still fall short while MORE UTXOs exist, the funds
      // are real but split across too many UTXOs to spend in one tx — tell the truth, don't claim
      // the balance is too low.
      if (entries.length > used.length) {
        throw new Error(
          `This amount needs more than ${WalletService.MAX_TX_INPUTS} UTXOs in one transaction. ` +
            `Consolidate your funds first, then send.`
        );
      }
      throw new Error("Amount exceeds your spendable balance.");
    }

    const build = (changeAmount: bigint) => {
      const outs = targetOutputs.map((o) => ({ ...o }));
      if (changeAmount > 0n) outs.push({ address: changeAddress, amount: changeAmount });
      if (outs.length === 0) throw new Error("Nothing to send.");
      // priority_fee 0n: the actual fee is inputs−outputs, which we set explicitly below.
      return kaspa.createTransaction(used as any, outs as any, 0n);
    };

    // 1) size the tx (change = everything not explicitly sent) to measure the minimum fee.
    let tx = this.stageSync("build", () => build(total - sent));
    const minFee = this.stageSync(
      "fee",
      () => (kaspa.calculateTransactionFee(this._networkId, tx) ?? 0n) as bigint
    );
    // Keryx enforces a minimum relay fee well above Kaspa's mass-based minimum (the node rejected a
    // 25102-sompi fee, "required amount of 30000000"). Floor the fee at KERYX_MIN_FEE.
    const massFee = BigInt(minFee);
    const fee =
      (massFee > WalletService.KERYX_MIN_FEE ? massFee : WalletService.KERYX_MIN_FEE) +
      extraFee;
    const change = total - sent - fee;
    if (change < 0n) {
      // A consolidate has no user "amount" (targetOutputs is empty) — the only spend is the network
      // fee, so a deficit means the balance is below the fee, not that an amount is too large.
      throw new Error(
        targetOutputs.length === 0
          ? "Your total balance is below the minimum network fee, so there is nothing to consolidate."
          : "Amount + network fee exceeds your balance."
      );
    }
    // 2) rebuild with the fee deducted from the change output, then sign + submit.
    tx = this.stageSync("build", () => build(change));
    // Pass keys as HEX STRINGS, not PrivateKey instances: the packaged build's wasm-bindgen
    // rejects instances here ("Unable to cast PrivateKey") — same cross-realm quirk as XPrv.
    // signTransaction accepts (PrivateKey | HexString | Uint8Array)[]; PrivateKey.toString()=hex.
    const signers = keys.map((k) => k.toString());
    const signed = this.stageSync("sign", () =>
      kaspa.signTransaction(tx, signers as any, true)
    );
    const res = await this.stage(
      "submit",
      () => this.wallet!.rpc.submitTransaction({ transaction: signed as any }),
      WalletService.SUBMIT_TIMEOUT_MS
    );
    return res?.transactionId ?? "";
  }

  /** Synchronous sibling of stage(): preserves the SDK's string-throw message with a stage label. */
  private stageSync<T>(label: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
      throw new Error(`[${label}] ${msg}`);
    }
  }

  /** The WASM SDK throws plain STRINGS, not Error objects. Wrap a stage so the real message (and
   *  where it failed) survives up to the UI instead of becoming a generic "Could not …". Also
   *  time-boxed so a stage that HANGS (e.g. submit never returning) surfaces as "[stage] TIMEOUT"
   *  instead of an indefinite spinner. */
  private async stage<T>(label: string, fn: () => Promise<T>, ms = 20000): Promise<T> {
    try {
      return await this.withTimeout(fn(), ms, label);
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
      throw new Error(`[${label}] ${msg}`);
    }
  }

  /**
   * CONTEXT-FREE consolidate (compound). Sweeps the whole UTXO set into a single UTXO back to our
   * own change/receive address, via the synchronous build path (no async Generator → no hang).
   *
   * ROUND-BASED. One transaction can only carry MAX_TX_INPUTS inputs, so a big set needs many
   * transactions — but they do NOT need to be serialized. Each round takes ONE snapshot, partitions
   * it into DISJOINT chunks of ≤MAX_TX_INPUTS, and submits every chunk (bounded concurrency). Since
   * no two chunks share an input, they cannot double-spend each other. Then it waits ONCE and starts
   * the next round over the compound outputs just created.
   *
   * That turns the cost from linear into logarithmic in round-trips:
   *   40,708 UTXOs → 509 → 7 → 1   (3 rounds, ~517 txs)
   *   247,500      → 3,094 → 39 → 1 (3 rounds)
   * The previous one-tx-per-round-trip loop needed ~517 and ~3,134 sequential waits respectively —
   * and its 200-batch cap meant a 40k wallet could never finish.
   *
   * The number of TRANSACTIONS is unchanged (mass per tx is the hard limit), so the fee is unchanged:
   * every tx pays KERYX_MIN_FEE. Use estimateConsolidateCost() to show that before starting.
   */
  async consolidateManual(
    password: string,
    onProgress?: (info: ConsolidateProgress) => void,
    maxFeeSompi?: bigint
  ): Promise<string[]> {
    if (!this.wallet || !this._accountId) throw new Error("Wallet is locked.");
    if (this.conn !== "connected" || !this.synced) {
      throw new Error("Connect to a synced node first.");
    }
    // Serialize money ops (see sendManual): don't let a concurrent send/consolidate build over the
    // same UTXO set. The whole multi-round run holds the lock.
    if (this.txInFlight) {
      throw new Error("Another transaction is already in progress. Please wait.");
    }
    this.txInFlight = true;
    let keyMap: Map<string, kaspa.PrivateKey>;
    try {
      // deriveKeyMap throws on a wrong password. That path MUST release the money-op lock too —
      // otherwise one typo here leaves txInFlight stuck and every later send/consolidate fails
      // with "another transaction is in progress" until the app restarts.
      keyMap = this.deriveKeyMap(password);
      this.assertDerivationMatches(keyMap);
    } catch (e) {
      this.txInFlight = false;
      throw e;
    }
    const keys = Array.from(keyMap.values());
    const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
    if (!changeAddress) {
      this.txInFlight = false;
      throw new Error("No change/receive address available.");
    }

    const txids: string[] = [];
    const run: ConsolidateRun = {
      running: true,
      round: 0,
      roundsEstimate: 1,
      startCount: 0,
      remaining: 0,
      txsSubmitted: 0,
      txsFailed: 0,
      txids,
      feePaidSompi: 0n,
      startedAt: Date.now(),
      lastError: null,
      stopRequested: false,
      phase: "building",
    };
    this.consolidateRun = run;
    this.emit();

    try {
      for (let round = 1; round <= WalletService.MAX_CONSOLIDATE_ROUNDS; round++) {
        if (run.stopRequested) {
          run.phase = "stopped";
          break;
        }
        // The run sweeps into the account that was active when it STARTED. If the user switched
        // accounts mid-run (the run survives closing the modal), continuing would sweep the new
        // account's UTXOs into the old account's address — stop instead. selectReceiveAddress is
        // also guarded, so this is a belt-and-braces check.
        if (this.receiveAddress !== changeAddress) {
          throw new Error(
            "The active account changed while consolidating, so the run was stopped for safety. " +
              "Transactions already submitted are unaffected."
          );
        }
        run.round = round;
        run.phase = "building";
        this.emit();

        // requireDaa: without the node's DAA we cannot tell mature from immature, and spending an
        // immature input just burns a fee on a rejected tx.
        const entries = await this.fetchEntries(true);
        if (round === 1) {
          run.startCount = entries.length;
        }
        run.remaining = entries.length;
        run.roundsEstimate = WalletService.estimateRounds(entries.length);
        this.emit();

        if (entries.length < 2) {
          if (round === 1) throw new Error("Nothing to consolidate (need at least 2 UTXOs).");
          break;
        }

        // Partition into disjoint chunks. A trailing chunk of 1 is dropped: a 1-input consolidate
        // pays a fee to achieve nothing.
        const chunks: any[][] = [];
        for (let i = 0; i < entries.length; i += WalletService.MAX_TX_INPUTS) {
          const chunk = entries.slice(i, i + WalletService.MAX_TX_INPUTS);
          if (chunk.length >= 2) chunks.push(chunk);
        }
        if (chunks.length === 0) break;
        if (run.txsSubmitted + chunks.length > WalletService.MAX_CONSOLIDATE_TXS) {
          throw new Error(
            `This run would need more than ${WalletService.MAX_CONSOLIDATE_TXS} transactions. ` +
              `Consolidate in stages instead.`
          );
        }
        // Never exceed the fee the user explicitly accepted. New UTXOs can arrive mid-run (mining
        // payouts) and previously-immature ones mature, so the up-front estimate is not a ceiling
        // by itself — trim the round to the remaining budget and stop when it is exhausted.
        if (maxFeeSompi != null) {
          const budgetTxs = Number(
            (maxFeeSompi - run.feePaidSompi) / WalletService.KERYX_MIN_FEE
          );
          if (chunks.length > budgetTxs) {
            chunks.length = Math.max(0, budgetTxs);
            if (chunks.length === 0) {
              run.lastError =
                "Reached the fee amount you accepted, stopping here. " +
                "Run Consolidate again to continue.";
              run.phase = "stopped";
              break;
            }
          }
        }

        // Every input must be signable before we build anything.
        for (const chunk of chunks) this.assertEntriesCovered(chunk, keyMap);

        run.phase = "submitting";
        this.emit();
        const result = await this.submitChunks(chunks, changeAddress, keys, run);
        txids.push(...result.txids);

        // A whole round failing on maturity means our floor is too low for this network — raise it
        // and retry the same round rather than reporting a confusing rejection.
        if (result.txids.length === 0) {
          if (run.stopRequested) {
            // Stop pressed before any chunk went out: that's a stop, not a failure.
            run.phase = "stopped";
            break;
          }
          if (result.maturityMsg !== null && this.escalateMaturity(result.maturityMsg)) {
            run.lastError = `Node requires older inputs, waiting a bit longer (retrying round ${round}).`;
            this.emit();
            round--; // retry this round with the raised floor
            await this.sleep(5000);
            continue;
          }
          throw new Error(result.firstError ?? "No transaction could be submitted.");
        }

        onProgress?.({
          batch: run.txsSubmitted,
          txid: result.txids[result.txids.length - 1],
          remaining: run.remaining,
        });

        if (run.stopRequested) {
          run.phase = "stopped";
          break;
        }

        run.phase = "waiting";
        this.emit();
        // Wait for this round's inputs to be consumed AND for the new outputs to reach the maturity
        // floor — the next round spends those outputs, and spending them too early is precisely the
        // sequence-lock rejection this run is designed to avoid.
        const remaining = await this.waitForRound(result.spent);
        run.remaining = remaining;
        this.emit();
        if (remaining < 2) break;
      }

      // Preserve a terminal state a break already set (fee budget exhausted → "stopped"); only a
      // run that actually swept everything it could is "done".
      if (run.phase !== "stopped") {
        run.phase = run.stopRequested ? "stopped" : "done";
      }
      return txids;
    } catch (e) {
      run.phase = "failed";
      run.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      run.running = false;
      this.txInFlight = false;
      this.emit();
      void this.refreshBalanceFromUtxos();
    }
  }

  /** ceil(log_MAX_TX_INPUTS(n)) — how many rounds a set of n UTXOs still needs. */
  private static estimateRounds(n: number): number {
    let rounds = 0;
    let count = n;
    while (count > 1 && rounds < WalletService.MAX_CONSOLIDATE_ROUNDS) {
      count = Math.ceil(count / WalletService.MAX_TX_INPUTS);
      rounds++;
    }
    return Math.max(1, rounds);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Build + sign + submit every chunk of one round, at most SUBMIT_CONCURRENCY in flight.
   *
   * A single chunk failing does NOT abort the run: its inputs simply stay unspent and reappear in the
   * next round's snapshot, so the state self-heals. Note that a submit which TIMES OUT may still have
   * been accepted by the node; the next round would then build over already-spent inputs and get
   * rejected as a double-spend — harmless (no funds move, no fee) and corrected by the fresh
   * snapshot on the round after.
   */
  private async submitChunks(
    chunks: any[][],
    changeAddress: string,
    keys: kaspa.PrivateKey[],
    run: ConsolidateRun
  ): Promise<{
    txids: string[];
    spent: Set<string>;
    /** First rejection that looked like an immaturity/sequence-lock complaint, verbatim — the
     *  escalation needs the wording to raise the right floor (coinbase vs user-tx). */
    maturityMsg: string | null;
    firstError: string | null;
  }> {
    const txids: string[] = [];
    const spent = new Set<string>();
    let maturityMsg: string | null = null;
    let firstError: string | null = null;
    let next = 0;

    const worker = async () => {
      for (;;) {
        if (run.stopRequested) return;
        const i = next++;
        if (i >= chunks.length) return;
        const chunk = chunks[i];
        // Yield to the event loop before each transaction. Building and signing are SYNCHRONOUS wasm
        // calls (80 inputs each), so without this a 500-tx round would freeze the window solid — no
        // repaint, no progress, no Stop button. The await lets React paint between transactions.
        await this.sleep(0);
        try {
          // No explicit outputs → everything minus the fee goes to one change output = a compound.
          const txid = await this.buildSignSubmitSync(chunk, changeAddress, [], keys, 0n);
          txids.push(txid);
          chunk.forEach((e) => spent.add(outpointKey(e)));
          run.txsSubmitted++;
          run.feePaidSompi += WalletService.KERYX_MIN_FEE;
          // A consolidate is a self-send: funds stay yours, so record it as a neutral entry showing
          // the amount swept by this transaction.
          this.recordLocalActivity({
            id: txid,
            type: "consolidate",
            direction: "other",
            amountSompi: chunk.reduce((s: bigint, e: any) => s + BigInt(e.amount), 0n),
            timestamp: Date.now(),
            fromAddress: this.receiveAddress ?? undefined,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          run.txsFailed++;
          if (maturityMsg === null && WalletService.isMaturityRejection(msg)) maturityMsg = msg;
          if (firstError === null) firstError = msg;
          run.lastError = msg;
        }
        this.emit();
      }
    };

    const lanes = Math.min(WalletService.SUBMIT_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return { txids, spent, maturityMsg, firstError };
  }

  /**
   * Wait for a round to settle: none of its inputs left in our UTXO set, then a maturity pause so
   * the freshly created compound outputs are actually spendable in the next round.
   *
   * Uses the cheap outpoint-only read (fetchOutpointKeys) with a growing interval — on a 250k-UTXO
   * wallet the old full mapped fetch every 2.5s was itself the bottleneck. Returns the remaining
   * UTXO count.
   */
  private async waitForRound(spent: Set<string>, timeoutMs = 600000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let pollMs = 2500;
    let keys = await this.fetchOutpointKeys();
    for (;;) {
      // Live count for the UI on every poll — this read already paid for the data, and it keeps
      // the progress bar moving without any extra full-set fetch from the modal.
      if (this.consolidateRun) {
        this.consolidateRun.remaining = keys.size;
        this.emit();
      }
      // Honor Stop during the wait too: this phase can last minutes, and ignoring the button here
      // used to end the run with a bogus "failed" state one round later.
      if (this.consolidateRun?.stopRequested) return keys.size;
      let stillThere = false;
      for (const k of spent) {
        if (keys.has(k)) {
          stillThere = true;
          break;
        }
      }
      if (!stillThere) break;
      if (Date.now() > deadline) {
        throw new Error(
          "The consolidation transactions did not confirm in time. The ones already submitted are " +
            "real. Check your UTXO count and run it again if needed."
        );
      }
      await this.sleep(pollMs);
      pollMs = Math.min(pollMs * 1.5, 10000);
      keys = await this.fetchOutpointKeys();
    }
    // Inputs are consumed, so the new outputs exist. Let them age past the user-tx maturity floor
    // before the next round spends them. DAA advances ~1/s, so this is seconds, once per round.
    await this.waitForMaturity();
    // The last poll's snapshot already reflects this round (inputs gone, compounds present) — reuse
    // its count instead of paying for one more full fetch per round on a huge wallet.
    return keys.size;
  }

  /** Pause until the DAA score has advanced past the user-tx maturity floor (plus a small margin).
   *  Aborts promptly on Stop or lock — an escalated floor can make this wait minutes, and holding
   *  the run (and its derived keys) alive after a lock would violate what "locked" means. */
  private async waitForMaturity(): Promise<void> {
    const startDaa = this.nodeDaa;
    if (startDaa == null) {
      // No DAA reference at all: wall-clock fallback (~1 DAA/s), bounded and stoppable.
      const end = Date.now() + Math.min(Number(this.userTxMaturity) * 1000, 180000);
      while (Date.now() < end) {
        if (!this.wallet || this.consolidateRun?.stopRequested) return;
        await this.sleep(2000);
      }
      return;
    }
    const target = startDaa + this.userTxMaturity + 2n;
    const deadline = Date.now() + 180000;
    for (;;) {
      if (!this.wallet || this.consolidateRun?.stopRequested) return;
      let daa = this.nodeDaa;
      try {
        const info = await this.wallet.rpc.getServerInfo();
        daa = info.virtualDaaScore;
        this.nodeDaa = daa;
      } catch {
        /* keep the cached value; the status poll also refreshes it */
      }
      if (daa != null && daa >= target) return;
      if (Date.now() > deadline) return; // don't stall the run on a slow DAA read
      await this.sleep(2000);
    }
  }

  /**
   * What a full consolidation of the CURRENT set would cost, before committing to it. Every
   * transaction pays KERYX_MIN_FEE, and a large miner wallet needs thousands of them — at 250k UTXOs
   * that is ~940 KRX, which the user must see up front rather than discover afterwards.
   */
  async estimateConsolidateCost(): Promise<{
    utxoCount: number;
    txCount: number;
    rounds: number;
    feeSompi: bigint;
  }> {
    const { count } = await this.utxoStats();
    let txCount = 0;
    let remaining = count;
    while (remaining > 1 && txCount <= WalletService.MAX_CONSOLIDATE_TXS) {
      const txs = Math.floor(remaining / WalletService.MAX_TX_INPUTS);
      const tail = remaining % WalletService.MAX_TX_INPUTS;
      const thisRound = txs + (tail >= 2 ? 1 : 0);
      if (thisRound === 0) break;
      txCount += thisRound;
      remaining = thisRound + (tail === 1 ? 1 : 0);
    }
    return {
      utxoCount: count,
      txCount,
      rounds: WalletService.estimateRounds(count),
      feeSompi: BigInt(txCount) * WalletService.KERYX_MIN_FEE,
    };
  }

  /** Discard a finished run's state so the UI returns to the start form. No-op while one runs. */
  clearConsolidateRun(): void {
    if (this.consolidateRun && !this.consolidateRun.running) {
      this.consolidateRun = null;
      this.emit();
    }
  }

  /** Ask the running consolidation to stop. It finishes the current round first — never mid-round. */
  stopConsolidate(): void {
    if (this.consolidateRun?.running) {
      this.consolidateRun.stopRequested = true;
      this.emit();
    }
  }

  /** True while a consolidation is in progress (used to hold off the auto-lock). */
  get isConsolidating(): boolean {
    return this.consolidateRun?.running === true;
  }

  /**
   * READ-ONLY snapshot of the account's UTXO set straight from the node (getUtxosByAddresses).
   * Used to show "how many UTXOs you have / how many remain" during consolidation. Touches nothing
   * — no signing, no state change on the wallet/node/chain.
   */
  async utxoStats(): Promise<{ count: number; totalSompi: bigint }> {
    if (!this.wallet || this.activeAddresses().length === 0) {
      return { count: 0, totalSompi: 0n };
    }
    // Time-boxed like the other UTXO reads: the UI polls this every few seconds and on a very large
    // wallet the response is big enough to hang without a guard.
    const res = await this.withTimeout(
      this.wallet.rpc.getUtxosByAddresses(this.activeAddresses()),
      WalletService.UTXO_FETCH_TIMEOUT_MS,
      "utxo-fetch"
    );
    const entries = (res?.entries ?? []) as Array<{ amount?: bigint }>;
    let total = 0n;
    for (const e of entries) {
      try {
        total += BigInt(e.amount ?? 0n);
      } catch {
        /* skip */
      }
    }
    return { count: entries.length, totalSompi: total };
  }

  /**
   * Validate an address with the SDK AND check its prefix matches the active
   * network. Returns true only when both pass.
   */
  validateAddress(str: string): boolean {
    const trimmed = (str || "").trim();
    if (!trimmed) return false;
    let ok = false;
    try {
      ok = kaspa.Address.validate(trimmed);
    } catch {
      ok = false;
    }
    if (!ok) {
      // Fallback: constructor throws on invalid input.
      try {
        // eslint-disable-next-line no-new
        new kaspa.Address(trimmed);
        ok = true;
      } catch {
        return false;
      }
    }
    // Network guard: the address prefix must match the active network prefix.
    const expected = this.expectedAddressPrefix();
    if (expected) {
      const got = trimmed.split(":")[0];
      if (got !== expected) return false;
    }
    return true;
  }

  /** Derive a fresh receive address and update observable state. */
  async newReceiveAddress(): Promise<string> {
    if (!this.wallet || !this._accountId) {
      throw new Error("Wallet is locked.");
    }
    // Same reason as selectReceiveAddress: this switches the active address.
    if (this.txInFlight) {
      throw new Error(
        "A transaction or consolidation is in progress. Stop it before switching accounts."
      );
    }
    if (this.receiveAddresses.length >= WalletService.MAX_RECEIVE_ADDRESSES) {
      throw new Error(
        `This wallet keeps up to ${WalletService.MAX_RECEIVE_ADDRESSES} addresses. Pick one from the list instead.`
      );
    }
    const res = await this.wallet.accountsCreateNewAddress({
      accountId: this._accountId,
      addressKind: kaspa.NewAddressKind.Receive,
    });
    const addr =
      typeof res === "string"
        ? res
        : (res as any)?.address?.toString?.() ??
          (res as any)?.address ??
          String(res);
    this.receiveAddress = addr;
    // Track it so the node-RPC balance fallback also watches funds sent to this new address.
    if (addr && !this.accountAddresses.includes(addr)) {
      this.accountAddresses.push(addr);
    }
    if (addr && !this.receiveAddresses.includes(addr)) {
      this.receiveAddresses.push(addr);
      this.receiveAddresses = this.receiveAddresses.slice(
        0,
        WalletService.MAX_RECEIVE_ADDRESSES
      );
    }
    this.persistReceiveList();
    this.emit();
    return addr;
  }

  /** The receive addresses the user can switch between (MetaMask-style). */
  getReceiveAddresses(): string[] {
    return [...this.receiveAddresses];
  }

  /** Whether another address can still be created (under the cap). */
  get canAddReceiveAddress(): boolean {
    return this.receiveAddresses.length < WalletService.MAX_RECEIVE_ADDRESSES;
  }

  /** Make `addr` (one of the switcher addresses) the active receive address. Persisted. */
  selectReceiveAddress(addr: string): void {
    // Money ops capture the active address when they start and scan the ACTIVE address each round.
    // Switching mid-run would make a background consolidation sweep the newly selected account's
    // UTXOs into the old account's address — refuse until it finishes or is stopped.
    if (this.txInFlight) {
      throw new Error(
        "A transaction or consolidation is in progress. Stop it before switching accounts."
      );
    }
    if (!this.receiveAddresses.includes(addr)) {
      throw new Error("That address is not one of your wallet's addresses.");
    }
    this.receiveAddress = addr;
    if (this._accountId) {
      try {
        const map = WalletService.readMap<string>(RECEIVE_ACTIVE_BY_ACCOUNT_KEY);
        map[this._accountId] = addr;
        localStorage.setItem(RECEIVE_ACTIVE_BY_ACCOUNT_KEY, JSON.stringify(map));
      } catch {
        /* non-fatal */
      }
    }
    // Switching account → clear the previous account's balance and load this one's.
    this.balance = { mature: 0n, pending: 0n };
    this.emit();
    void this.refreshBalanceFromUtxos();
  }

  /**
   * List the wallet's accounts WITHOUT asking for the password. Derives receive+change addresses
   * 0..depth from the cached public-key generator (set at open), reads each balance, and returns the
   * ones that hold funds plus the managed/active addresses — MetaMask-style, no scan button. Funded
   * addresses are adopted into the watched set so the balance includes them. Active first, then balance.
   */
  async listAccounts(depth = 30): Promise<
    Array<{ address: string; balanceSompi: bigint; kind: "receive" | "change"; isActive: boolean }>
  > {
    if (!this.wallet) return [];
    const cand: Array<{ address: string; kind: "receive" | "change" }> = [];
    const push = (a: string, kind: "receive" | "change") => {
      if (a && !cand.find((c) => c.address === a)) cand.push({ address: a, kind });
    };
    if (this.pubGen) {
      try {
        const r = this.pubGen.receiveAddressAsStrings(this._networkId, 0, depth);
        const c = this.pubGen.changeAddressAsStrings(this._networkId, 0, depth);
        r.forEach((a) => push(a, "receive"));
        c.forEach((a) => push(a, "change"));
      } catch {
        /* fall through to the managed set */
      }
    }
    this.receiveAddresses.forEach((a) => push(a, "receive"));
    if (this.receiveAddress) push(this.receiveAddress, "receive");

    const bal = new Map<string, bigint>();
    try {
      const res = await this.wallet.rpc.getBalancesByAddresses(cand.map((c) => c.address));
      for (const e of (res?.entries ?? []) as Array<{ address?: any; balance?: bigint }>) {
        const ad = e.address?.toString?.() ?? String(e.address ?? "");
        let b = 0n;
        try {
          b = BigInt(e.balance ?? 0n);
        } catch {
          b = 0n;
        }
        bal.set(ad, b);
      }
    } catch {
      /* node balances unavailable — still return addresses (balance 0) */
    }

    let adopted = false;
    for (const c of cand) {
      if ((bal.get(c.address) ?? 0n) > 0n && !this.accountAddresses.includes(c.address)) {
        this.accountAddresses.push(c.address);
        adopted = true;
      }
    }
    if (adopted) this.emit();

    const out = cand
      .filter(
        (c) =>
          (bal.get(c.address) ?? 0n) > 0n ||
          this.receiveAddresses.includes(c.address) ||
          c.address === this.receiveAddress
      )
      .map((c) => ({
        address: c.address,
        balanceSompi: bal.get(c.address) ?? 0n,
        kind: c.kind,
        isActive: c.address === this.receiveAddress,
      }));
    out.sort((a, b) =>
      a.isActive
        ? -1
        : b.isActive
          ? 1
          : b.balanceSompi > a.balanceSompi
            ? 1
            : b.balanceSompi < a.balanceSompi
              ? -1
              : 0
    );
    return out;
  }

  /** Switch to an account from the list — adopts it (managed + watched + signable) and makes it
   *  active. Not subject to the create cap (you're viewing your own funds, not creating). */
  useAccount(addr: string): void {
    if (!addr) return;
    if (!this.receiveAddresses.includes(addr)) {
      this.receiveAddresses.push(addr);
      this.persistReceiveList();
    }
    if (!this.accountAddresses.includes(addr)) this.accountAddresses.push(addr);
    this.selectReceiveAddress(addr);
  }

  /** Load the ACTIVE ACCOUNT's saved switcher list + selection; seed it with its own address. */
  private initReceiveList(): void {
    const accountId = this._accountId;
    let list: string[] = [];
    if (accountId) {
      const stored = WalletService.readMap<string[]>(RECEIVE_LIST_BY_ACCOUNT_KEY)[accountId];
      if (Array.isArray(stored)) list = stored.filter((x) => typeof x === "string");
    }
    if (list.length === 0 && this.receiveAddress) {
      list = [this.receiveAddress];
    }
    this.receiveAddresses = list.slice(0, WalletService.MAX_RECEIVE_ADDRESSES);
    for (const a of this.receiveAddresses) {
      if (!this.accountAddresses.includes(a)) this.accountAddresses.push(a);
    }
    this.persistReceiveList();
    const active = accountId
      ? WalletService.readMap<string>(RECEIVE_ACTIVE_BY_ACCOUNT_KEY)[accountId]
      : null;
    if (active && this.receiveAddresses.includes(active)) {
      this.receiveAddress = active;
    }
  }

  private persistReceiveList(): void {
    if (!this._accountId) return;
    try {
      const map = WalletService.readMap(RECEIVE_LIST_BY_ACCOUNT_KEY);
      map[this._accountId] = this.receiveAddresses;
      localStorage.setItem(RECEIVE_LIST_BY_ACCOUNT_KEY, JSON.stringify(map));
    } catch {
      /* non-fatal */
    }
  }

  /** Read a { [accountId]: T } blob from localStorage, tolerating anything malformed. */
  private static readMap<T>(key: string): Record<string, T> {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Move the pre-multi-wallet flat switcher list under the first account. Those keys held addresses
   * of the only seed there was; leaving them global would offer one wallet an address derived from
   * another seed, which it cannot sign for. The v1 keys are left in place so an older build still
   * works.
   */
  private migrateLegacyReceiveList(firstAccountId: string): void {
    try {
      const listMap = WalletService.readMap<string[]>(RECEIVE_LIST_BY_ACCOUNT_KEY);
      if (!listMap[firstAccountId]) {
        const raw = localStorage.getItem(RECEIVE_LIST_KEY);
        if (raw) {
          const legacy = (JSON.parse(raw) as unknown[]).filter(
            (x): x is string => typeof x === "string"
          );
          if (legacy.length > 0) {
            listMap[firstAccountId] = legacy;
            localStorage.setItem(RECEIVE_LIST_BY_ACCOUNT_KEY, JSON.stringify(listMap));
          }
        }
      }
      const activeMap = WalletService.readMap<string>(RECEIVE_ACTIVE_BY_ACCOUNT_KEY);
      if (!activeMap[firstAccountId]) {
        const legacyActive = localStorage.getItem(RECEIVE_ACTIVE_KEY);
        if (legacyActive) {
          activeMap[firstAccountId] = legacyActive;
          localStorage.setItem(RECEIVE_ACTIVE_BY_ACCOUNT_KEY, JSON.stringify(activeMap));
        }
      }
    } catch {
      /* non-fatal: the switcher just starts from the account's own address */
    }
  }

  /** Parse a user-entered KRX string to sompi (bigint). Throws on bad input. */
  kaspaToSompi(str: string): bigint {
    const v = kaspa.kaspaToSompi(str.trim());
    if (v === undefined || v === null) {
      throw new Error("Invalid amount.");
    }
    return v;
  }

  // --- internals ---

  /** Expected address prefix for the active network (derived at runtime). */
  private expectedAddressPrefix(): string | null {
    try {
      const sample =
        "0000000000000000000000000000000000000000000000000000000000000001";
      const addr = new kaspa.PrivateKey(sample)
        .toAddress(this._networkId)
        .toString();
      return addr.split(":")[0] || null;
    } catch {
      // Fall back to the boot-verified mainnet prefix if derivation fails.
      return this.addressPrefix;
    }
  }

  /** Read our locally-recorded activity (sends/consolidates made from this wallet). */
  private readLocalActivity(): HistoryEntry[] {
    try {
      const raw = localStorage.getItem(LOCAL_ACTIVITY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as Array<{
        id: string;
        type: string;
        direction: HistoryEntry["direction"];
        amountSompi: string;
        timestamp?: number;
        fromAddress?: string;
      }>;
      return arr.map((e) => ({
        id: e.id,
        type: e.type,
        direction: e.direction,
        amountSompi: (() => {
          try {
            return BigInt(e.amountSompi);
          } catch {
            return 0n;
          }
        })(),
        timestamp: e.timestamp,
        fromAddress: e.fromAddress,
      }));
    } catch {
      return [];
    }
  }

  /** Append one entry to the local activity log (no-op without a txid; de-duped by txid). */
  private recordLocalActivity(entry: HistoryEntry): void {
    if (!entry.id) return;
    try {
      const existing = this.readLocalActivity();
      if (existing.some((e) => e.id === entry.id)) return;
      // bigint isn't JSON-serializable → persist the amount as a decimal string.
      const serialized = [entry, ...existing]
        .slice(0, 200)
        .map((e) => ({ ...e, amountSompi: e.amountSompi.toString() }));
      localStorage.setItem(LOCAL_ACTIVITY_KEY, JSON.stringify(serialized));
    } catch {
      /* localStorage may be unavailable; the on-chain tx is unaffected, so non-fatal. */
    }
  }

  /** Drop the local activity log (called when a different wallet is created/imported). */
  private clearLocalActivity(): void {
    try {
      localStorage.removeItem(LOCAL_ACTIVITY_KEY);
      localStorage.removeItem(RECEIVED_LOG_KEY);
      localStorage.removeItem(RECEIVE_LIST_KEY);
      localStorage.removeItem(RECEIVE_ACTIVE_KEY);
    } catch {
      /* non-fatal */
    }
  }

  private ensureWallet() {
    if (!this.wasmReady) throw new Error("WASM not initialized");
    if (!this.wallet) {
      this.buildWallet(this.nodeSettings);
    }
  }

  /**
   * Construct the SDK wallet for an endpoint and remember which endpoint it is for. Every
   * `kaspa.Wallet` owns WASM-side state, so only ever hold one: callers must drop the previous
   * one (see setNode) rather than letting two coexist.
   */
  private buildWallet(settings: NodeSettings) {
    this.wallet = new kaspa.Wallet({
      resident: false,
      networkId: settings.networkId,
      encoding: kaspa.Encoding.Borsh,
      url: settings.url,
    });
    this.walletEndpoint = `${settings.url}|${settings.networkId}`;
    this.attachEvents();
  }

  private attachEvents() {
    if (!this.wallet) return;
    // single-callback form: ({ type, data }) per SDK_CONTRACT.md
    const w = this.wallet as unknown as {
      addEventListener: (cb: (e: { type: string; data?: any }) => void) => void;
    };
    w.addEventListener((event) => {
      const { type, data } = event;
      // instrumentation: prove whether SDK events fire at all
      this.eventCount++;
      this.lastEventTypes.push(String(type));
      if (this.lastEventTypes.length > 10) this.lastEventTypes.shift();
      switch (type) {
        case "connect":
          this.conn = "connected";
          break;
        case "disconnect":
          this.conn = "disconnected";
          this.synced = false;
          break;
        case "sync-state": {
          const synced = data?.isSynced ?? data?.synced;
          if (typeof synced === "boolean") this.synced = synced;
          break;
        }
        case "server-status": {
          if (typeof data?.isSynced === "boolean") this.synced = data.isSynced;
          break;
        }
        case "balance": {
          const b = data?.balance;
          if (b) {
            this.gotBalanceEvent = true; // authoritative — overrides the UTXO-sum fallback
            this.balance = {
              mature: BigInt(b.mature ?? 0n),
              pending: BigInt(b.pending ?? 0n),
            };
          }
          this.scanning = false; // we have balance data → discovery done
          break;
        }
        case "error": {
          this.lastError = typeof data === "string" ? data : "wallet error";
          break;
        }
        default:
          break;
      }
      this.emit();
    });
  }
}

export const wallet = new WalletService();

/**
 * Format sompi (bigint, 1e8 per KRX) to an exact KRX string, trailing zeros trimmed.
 *
 * Done with bigint arithmetic rather than the SDK's sompiToKaspaString, which routes through
 * an f64 and so silently rounds above 2^53 sompi (~90,071,992 KRX): 999999999969999999 came
 * back as "9999999999.7". This is the formatter the confirm screen uses to state what is
 * about to be signed, so it has to be exact at every balance. Output matches the SDK's for
 * everything below that threshold.
 */
/**
 * Holder-reward (ratio-reward) state of ONE payout address, from the explorer API. Meaningful
 * only for an address that actually mines. `effBalance` is the coin-age effective balance.
 * The income fields are reserved for the payout split the API does not serve yet.
 */
export interface HolderReward {
  address: string;
  virtualDaaScore: bigint;
  effBalance: bigint;
  productionRaw: bigint;
  production: bigint;
  bracketBps: bigint;
  nextBracketBps: bigint | null;
  nextBracketBalance: bigint | null;
  fullBracketBalance: bigint;
  windowDaa: bigint;
  active: boolean;
  paid: bigint;
  burned: bigint;
  escrow: bigint;
  inference: bigint;
  incomeWindowDaa: bigint;
  tierBase: bigint[];
}

/** Service-ledger standing of one payout address. */
export interface ServiceStanding {
  consecutiveMisses: number;
  lastStrikeDaaScore: bigint | null;
  suspendedUntilDaaScore: bigint | null;
  pendingBurnCount: number;
  pendingBurnSompi: bigint;
  lifetimeStrikes: number;
}

export function formatKrx(sompi: bigint): string {
  const neg = sompi < 0n;
  const v = neg ? -sompi : sompi;
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? `.${frac}` : "");
}

/** Group the integer part of an exact KRX string with thousands separators, for display. Unlike
 *  formatKrxShort this keeps every decimal, so the result still round-trips through
 *  normalizeAmountInput + kaspaToSompi without losing sompi. */
export function groupKrx(krx: string): string {
  const [whole, frac] = krx.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
}

/**
 * Turn whatever is in an amount field into the plain decimal string the node accepts. A field
 * can legitimately hold our own display formatting (thousands separators) — after "send max",
 * or from a paste — so separators come off here, but only when the commas form real 3-digit
 * groups. A lone comma is ambiguous (decimal separator in most of the world, grouping in ours)
 * and misreading it would move the amount by 1000x, so we refuse instead of guessing.
 */
export function normalizeAmountInput(
  input: string
): { value: string } | { error: string } {
  const s = input.trim().replace(/[\s_']/g, "");
  if (!s) return { error: "Enter an amount." };
  if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
      return { error: "Use a dot for decimals (e.g. 12.5), not a comma." };
    }
    return { value: s.replace(/,/g, "") };
  }
  return { value: s };
}

/** Display-only KRX: thousands separators + at most 4 decimals (trailing zeros trimmed), TRUNCATED
 *  (never rounds up). Use for balances/lists where space is tight; use formatKrx for exact amounts. */
export function formatKrxShort(sompi: bigint): string {
  const neg = sompi < 0n;
  const v = neg ? -sompi : sompi;
  const whole = v / 100000000n;
  const frac = (v % 100000000n)
    .toString()
    .padStart(8, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + wholeStr + (frac ? "." + frac : "");
}
