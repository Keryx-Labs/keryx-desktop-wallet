// Keryx wallet service — wraps the audited wallet-core WASM SDK.
// Wired strictly against SDK_CONTRACT.md. We NEVER log password / mnemonic / seed.

import * as kaspa from "../sdk/kaspa.js";
import wasmUrl from "../sdk/kaspa_bg.wasm?url";

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

export interface NodeSettings {
  url: string;
  networkId: string;
}

export const DEFAULT_NODE: NodeSettings = {
  url: "ws://127.0.0.1:23110",
  networkId: "mainnet",
};

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

/** Stable identity for a UTXO (transactionId:index), used to tell when a batch's inputs are gone. */
function outpointKey(e: { outpoint?: { transactionId?: string; index?: number } }): string {
  const op = e.outpoint ?? {};
  return `${op.transactionId ?? ""}:${op.index ?? 0}`;
}

type Listener = () => void;

class WalletService {
  private wallet: kaspa.Wallet | null = null;
  private wasmReady = false;
  private _accountId: string | null = null;
  private _networkId: string = DEFAULT_NODE.networkId;

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
  /** Active account id (hex), or null when locked. */
  get accountId(): string | null {
    return this._accountId;
  }
  /** Active network id string, e.g. "mainnet". */
  get networkId(): string {
    return this._networkId;
  }

  /** Load WASM and verify (at runtime) the real Keryx address prefix. */
  async init(): Promise<void> {
    if (this.wasmReady) return;
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
   * Step 2 of creation: persist the wallet, store the private key data from the
   * (backed-up) mnemonic and create the first account, then open it.
   */
  async finishCreate(password: string, mnemonicPhrase: string): Promise<void> {
    this.ensureWallet();
    const w = this.wallet!;
    await w.walletCreate({
      walletSecret: password,
      filename: WALLET_FILENAME,
      title: WALLET_TITLE,
    });
    const pk = await w.prvKeyDataCreate({
      walletSecret: password,
      kind: "mnemonic",
      mnemonic: mnemonicPhrase,
    });
    await w.accountsCreate({
      walletSecret: password,
      type: "bip32",
      accountName: "Account 1",
      prvKeyDataId: pk.prvKeyDataId,
    });
    this.storeSeedBackup(mnemonicPhrase, password);
    this.clearLocalActivity(); // fresh wallet → don't inherit a previous seed's activity
    await this.open(password);
  }

  /** Import an existing 12/24-word mnemonic into a fresh wallet, then open it. */
  async importMnemonic(password: string, phrase: string): Promise<void> {
    const clean = phrase.trim().replace(/\s+/g, " ");
    if (!kaspa.Mnemonic.validate(clean)) {
      throw new Error("Invalid recovery phrase.");
    }
    this.ensureWallet();
    const w = this.wallet!;
    await w.walletCreate({
      walletSecret: password,
      filename: WALLET_FILENAME,
      title: WALLET_TITLE,
    });
    const pk = await w.prvKeyDataCreate({
      walletSecret: password,
      kind: "mnemonic",
      mnemonic: clean,
    });
    await w.accountsCreate({
      walletSecret: password,
      type: "bip32",
      accountName: "Account 1",
      prvKeyDataId: pk.prvKeyDataId,
    });
    this.storeSeedBackup(clean, password);
    this.clearLocalActivity(); // imported wallet → start its activity log clean
    await this.open(password);
  }

  /** True if a recovery phrase is available to reveal for the current wallet. */
  hasSeedBackup(): boolean {
    try {
      return !!localStorage.getItem(SEED_BLOB_KEY);
    } catch {
      return false;
    }
  }

  /**
   * Reveal the recovery phrase. Decrypts our own password-encrypted copy; the correct password
   * is required (a wrong one throws). The phrase is returned to the caller, never logged.
   */
  revealMnemonic(password: string): string {
    const blob = (() => {
      try {
        return localStorage.getItem(SEED_BLOB_KEY);
      } catch {
        return null;
      }
    })();
    if (!blob) {
      throw new Error("No recovery phrase is stored for this wallet.");
    }
    // Decryption failing is the password being wrong; a successful decrypt that
    // yields an invalid phrase means the stored blob is corrupted, not a bad
    // password — report the two distinctly so the user is not misled.
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

  /** Encrypt the mnemonic with the wallet password and persist it (for reveal/backup). */
  private storeSeedBackup(phrase: string, password: string) {
    try {
      localStorage.setItem(
        SEED_BLOB_KEY,
        kaspa.encryptXChaCha20Poly1305(phrase, password)
      );
    } catch {
      /* non-fatal: reveal just won't be available */
    }
  }

  /**
   * Change the wallet password. Recovers the phrase with the OLD password first (which also
   * verifies it), rotates the SDK wallet secret, then re-encrypts our own seed-backup copy with
   * the NEW password so "reveal phrase" keeps working. Requires the wallet to be open.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.isOpen) throw new Error("Open the wallet first.");
    const w = this.wallet!;
    let phrase: string | null = null;
    if (this.hasSeedBackup()) {
      phrase = this.revealMnemonic(oldPassword); // throws "Wrong password." if wrong
    }
    try {
      await w.walletChangeSecret({
        oldWalletSecret: oldPassword,
        newWalletSecret: newPassword,
      });
    } catch {
      throw new Error("Could not change password (wrong current password?).");
    }
    if (phrase) this.storeSeedBackup(phrase, newPassword);
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
    const descriptors = opened.accountDescriptors ?? [];
    if (descriptors.length === 0) {
      throw new Error("Wallet has no accounts.");
    }
    const acc = descriptors[0];
    this._accountId = acc.accountId;
    this.receiveAddress = acc.receiveAddress
      ? acc.receiveAddress.toString()
      : null;
    this.gotBalanceEvent = false;
    this.accountAddresses = this.collectDescriptorAddresses(acc);
    this.initReceiveList(); // restore the saved receive-address switcher list + active selection
    // Cache the PUBLIC key generator (no private keys) so we can scan addresses later without the
    // password. We have the password here; deriving the generator is local + fast. Non-fatal.
    try {
      const phrase = this.revealMnemonic(password);
      const seed = new kaspa.Mnemonic(phrase).toSeed();
      const xprv = new kaspa.XPrv(seed);
      this.pubGen = kaspa.PublicKeyGenerator.fromMasterXPrv(
        xprv.toString(),
        false,
        0n
      );
    } catch {
      this.pubGen = null;
    }

    // UNLOCK = walletOpen succeeded (the wallet is decrypted). That is LOCAL and fast. We must NOT
    // block the unlock on anything network-bound: connecting to the node, starting the processor,
    // and especially activating the account (which kicks off the UTXO scan and can be slow or
    // stall) all run in the BACKGROUND below. The UI shows the dashboard immediately and the
    // connection/scan/balance fill in via the status bar — so "unlocking" can never hang.
    this.conn = "connecting";
    this.emit();
    void this.connectActivateScan(acc.accountId);
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
    if (this.isOpen) {
      await this.lock();
    }
    this._networkId = settings.networkId;
    // Recreate the wallet bound to the new endpoint/network.
    this.wallet = new kaspa.Wallet({
      resident: false,
      networkId: settings.networkId,
      encoding: kaspa.Encoding.Borsh,
      url: settings.url,
    });
    this.attachEvents();
    this.emit();
  }

  /** Lock: stop activity and forget the in-memory account. Storage is untouched. */
  async lock(): Promise<void> {
    const w = this.wallet;
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
    this.receiveAddress = null;
    this.receiveAddresses = [];
    this.pubGen = null;
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
   * Send funds. The password is used ONLY here (as walletSecret) and is never
   * stored or logged. SDK: accountsSend(...) → { transactionIds }.
   * Returns the submitted transaction ids.
   */
  async send(
    password: string,
    destAddress: string,
    amountSompi: bigint,
    priorityFeeSompi: bigint = 0n
  ): Promise<string[]> {
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
    password: string,
    onProgress?: (info: ConsolidateProgress) => void
  ): Promise<string[]> {
    // Same reason as send(): bypass the empty UtxoContext and sweep via the manual path.
    return this.consolidateManual(password, onProgress);
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
  /** Backstop for the consolidate auto-loop. Each batch nets at least −1 UTXO, so a real run needs
   *  ≈ceil((N−1)/(MAX_TX_INPUTS−1)) batches (e.g. ~8 for 600 UTXOs); this cap only trips if the set
   *  inexplicably fails to shrink. */
  private static readonly MAX_CONSOLIDATE_BATCHES = 200;
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
        "Key derivation does not match this wallet's addresses — aborting to avoid signing with " +
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
          `key for — aborting to avoid building an unspendable transaction.`
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

  private async fetchEntries(): Promise<any[]> {
    if (!this.wallet) throw new Error("Wallet is locked.");
    const scan = this.activeAddresses();
    if (scan.length === 0) {
      throw new Error("No active address to scan for UTXOs.");
    }
    const res = await this.wallet.rpc.getUtxosByAddresses(scan);
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
    // Skip immature coinbase (mining-reward) UTXOs: the node rejects a tx that spends one before
    // COINBASE_MATURITY DAA have passed, so only a miner with freshly-mined rewards hits this. Use
    // the live virtual DAA; refresh it once if we don't have it yet. If it stays unknown we don't
    // filter (the node would reject anyway — never worse). Excluding a borderline reward just
    // defers it to a later batch; it can't move wrong/double funds.
    let daa = this.nodeDaa;
    if (daa == null) {
      try {
        const info = await this.wallet.rpc.getServerInfo();
        daa = info.virtualDaaScore;
        this.nodeDaa = daa;
      } catch {
        /* leave daa null → skip the maturity filter this round */
      }
    }
    const spendable =
      daa != null
        ? mapped.filter(
            (e) => !e.isCoinbase || daa - e.blockDaaScore >= WalletService.COINBASE_MATURITY
          )
        : mapped;
    // Spend the LARGEST UTXOs first. A send/estimate is capped at MAX_TX_INPUTS inputs per tx, so
    // taking the node's arbitrary order could slice off dust and fail to fund a send that is well
    // within the real balance. Largest-first guarantees one tx funds the maximum possible amount.
    spendable.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
    return spendable;
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
          ? "Your total balance is below the minimum network fee — nothing to consolidate."
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
    const res = await this.stage("submit", () =>
      this.wallet!.rpc.submitTransaction({ transaction: signed as any })
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
   * One transaction can only carry MAX_TX_INPUTS inputs, so for a large set this AUTO-LOOPS: it
   * submits a batch of the largest ≤MAX_TX_INPUTS UTXOs, WAITS for the node to accept it and consume
   * those inputs, then re-reads a fresh UTXO set and submits the next batch — repeating until ≤1
   * UTXO remains. The wait between batches is essential: without it fetchEntries would return the
   * just-spent UTXOs (still in mempool, not yet removed from the utxoindex) and the next tx would
   * double-spend and be rejected. `onProgress` fires after each confirmed batch so the UI can show
   * the count dropping live. Returns every batch's txid.
   */
  async consolidateManual(
    password: string,
    onProgress?: (info: ConsolidateProgress) => void
  ): Promise<string[]> {
    if (!this.wallet || !this._accountId) throw new Error("Wallet is locked.");
    if (this.conn !== "connected" || !this.synced) {
      throw new Error("Connect to a synced node first.");
    }
    // Serialize money ops (see sendManual): don't let a concurrent send/consolidate build over the
    // same UTXO set. The whole multi-batch run holds the lock.
    if (this.txInFlight) {
      throw new Error("Another transaction is already in progress. Please wait.");
    }
    this.txInFlight = true;
    try {
      const keyMap = this.deriveKeyMap(password);
      this.assertDerivationMatches(keyMap);
      const keys = Array.from(keyMap.values());

      const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
      if (!changeAddress) throw new Error("No change/receive address available.");

      const txids: string[] = [];
      // Each batch removes at least one UTXO (used≥2 → net −(used−1)≥−1), so the loop always
      // terminates; MAX_CONSOLIDATE_BATCHES is a backstop against an unexpected non-shrinking set.
      for (let batch = 0; batch < WalletService.MAX_CONSOLIDATE_BATCHES; batch++) {
        const entries = await this.fetchEntries();
        if (entries.length < 2) {
          // Nothing (left) to consolidate. First iteration → honest error; later → we're simply done.
          if (batch === 0) throw new Error("Nothing to consolidate (need at least 2 UTXOs).");
          break;
        }

        const used = entries.slice(0, WalletService.MAX_TX_INPUTS);
        // Every UTXO in this batch must be signable, or the batch fails at submit.
        this.assertEntriesCovered(used, keyMap);
        const spent = new Set(used.map(outpointKey));

      // No explicit outputs → everything (minus fee) goes to the single change output = a compound.
      const txid = await this.buildSignSubmitSync(entries, changeAddress, [], keys, 0n);
      txids.push(txid);
      // A consolidate is a self-send: the funds stay yours, so record it as a neutral (no +/-) entry
      // showing the amount swept in this batch (the inputs actually used, capped at MAX_TX_INPUTS).
      const swept = used.reduce((s, e) => s + BigInt(e.amount), 0n);
      this.recordLocalActivity({
        id: txid,
        type: "consolidate",
        direction: "other",
        amountSompi: swept,
        timestamp: Date.now(),
        fromAddress: this.receiveAddress ?? undefined,
      });

      // Wait for the node to consume this batch's inputs before reading the set for the next one.
      // If it does not confirm in time, the batches we DID submit are real and recorded — stop here
      // and return them; the caller's live poll keeps tracking and the user can run it again.
      let remaining: number;
      try {
        remaining = await this.waitForInputsConsumed(spent);
      } catch {
        onProgress?.({ batch: batch + 1, txid, remaining: entries.length - used.length + 1 });
        break;
      }
      onProgress?.({ batch: batch + 1, txid, remaining });
      if (remaining < 2) break;
      }

      return txids;
    } finally {
      this.txInFlight = false;
    }
  }

  /**
   * Poll the node until NONE of the given input outpoints remain in our UTXO set — i.e. the batch we
   * just submitted has been accepted into the DAG and its inputs consumed (the new compound output
   * is then present too). Returns the remaining UTXO count. Time-boxed so a tx that never confirms
   * surfaces as an error instead of spinning forever.
   */
  private async waitForInputsConsumed(
    spent: Set<string>,
    timeoutMs = 120000,
    pollMs = 2500
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entries = await this.fetchEntries();
      if (!entries.some((e) => spent.has(outpointKey(e)))) return entries.length;
      if (Date.now() > deadline) {
        throw new Error("Consolidation batch did not confirm in time.");
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
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
    const res = await this.wallet.rpc.getUtxosByAddresses(this.activeAddresses());
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
    if (!this.receiveAddresses.includes(addr)) {
      throw new Error("That address is not one of your wallet's addresses.");
    }
    this.receiveAddress = addr;
    try {
      localStorage.setItem(RECEIVE_ACTIVE_KEY, addr);
    } catch {
      /* non-fatal */
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

  /** Load the saved switcher list + active selection on open; seed it with the index-0 address. */
  private initReceiveList(): void {
    let list: string[] = [];
    try {
      const raw = localStorage.getItem(RECEIVE_LIST_KEY);
      if (raw) list = (JSON.parse(raw) as string[]).filter((s) => typeof s === "string");
    } catch {
      list = [];
    }
    if (list.length === 0 && this.receiveAddress) {
      list = [this.receiveAddress];
    }
    this.receiveAddresses = list.slice(0, WalletService.MAX_RECEIVE_ADDRESSES);
    for (const a of this.receiveAddresses) {
      if (!this.accountAddresses.includes(a)) this.accountAddresses.push(a);
    }
    this.persistReceiveList();
    let active: string | null = null;
    try {
      active = localStorage.getItem(RECEIVE_ACTIVE_KEY);
    } catch {
      active = null;
    }
    if (active && this.receiveAddresses.includes(active)) {
      this.receiveAddress = active;
    }
  }

  private persistReceiveList(): void {
    try {
      localStorage.setItem(RECEIVE_LIST_KEY, JSON.stringify(this.receiveAddresses));
    } catch {
      /* non-fatal */
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
      this.wallet = new kaspa.Wallet({
        resident: false,
        networkId: DEFAULT_NODE.networkId,
        encoding: kaspa.Encoding.Borsh,
        url: DEFAULT_NODE.url,
      });
      this.attachEvents();
    }
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

/** Format sompi (bigint, 1e8 per KRX) to a KRX string. */
export function formatKrx(sompi: bigint): string {
  try {
    return kaspa.sompiToKaspaString(sompi);
  } catch {
    const whole = sompi / 100000000n;
    const frac = (sompi % 100000000n).toString().padStart(8, "0");
    return `${whole}.${frac}`;
  }
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
