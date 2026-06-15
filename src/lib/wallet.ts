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
}

/** Result of an estimate: fee + total to spend (both sompi). */
export interface SendEstimate {
  feeSompi: bigint;
  /** amount + fee (best-effort; finalAmount already includes fees when present). */
  totalSompi: bigint;
  /** Raw summary (only set by the async Generator path; sync path omits it). */
  summary?: kaspa.GeneratorSummary;
}

type Listener = () => void;

// Map of TransactionDataType-ish strings to a coarse direction.
const INCOMING_TYPES = new Set([
  "incoming",
  "external",
  "transfer-incoming",
  "change",
]);
const OUTGOING_TYPES = new Set(["outgoing", "transfer-outgoing", "batch"]);

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
  balance: WalletBalance = { mature: 0n, pending: 0n };
  lastError: string | null = null;

  private listeners = new Set<Listener>();
  private pollTimer: number | null = null;
  private scanTimer: number | null = null;
  private fallbackTimer: number | null = null;
  private gotBalanceEvent = false; // a real "balance" event takes precedence over the fallback sum
  private accountAddresses: string[] = []; // receive+change(+more) for the direct-UTXO fallback
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
        this.accountAddresses
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

  /**
   * Fetch recent transaction activity, normalized to HistoryEntry[].
   * SDK: transactionsDataGet({ accountId, networkId, start, end }) → { transactions: ITransactionRecord[] }.
   */
  async history(limit = 50): Promise<HistoryEntry[]> {
    if (!this.wallet || !this._accountId) return [];
    const res = await this.wallet.transactionsDataGet({
      accountId: this._accountId,
      networkId: this._networkId,
      start: 0n,
      end: BigInt(limit),
    });
    const fromStore = (res?.transactions ?? []).map((tx) => this.normalizeRecord(tx));
    // Merge our locally-recorded sends/consolidates (which the SDK store never sees, see
    // LOCAL_ACTIVITY_KEY). De-dupe by txid, preferring the store's record if both exist.
    const seen = new Set(fromStore.map((e) => e.id).filter(Boolean));
    const merged = [...fromStore, ...this.readLocalActivity().filter((e) => !seen.has(e.id))];
    // Newest first; entries without a timestamp sink to the bottom.
    merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return merged.slice(0, limit);
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
    const entries = (await this.fetchEntries()).slice(0, WalletService.MAX_TX_INPUTS);
    if (entries.length === 0) throw new Error("No spendable UTXOs found.");
    const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
    if (!changeAddress) throw new Error("No change address available.");
    const total: bigint = entries.reduce(
      (s: bigint, e: any) => s + BigInt(e.amount),
      0n
    );
    const sent: bigint = amountSompi <= total ? amountSompi : total;
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
   * Consolidate (compound) UTXOs: spends your many small UTXOs back to your own change address in
   * as few transactions as possible — the SDK batches automatically when they don't fit one tx.
   * Implemented via accountsSend WITHOUT a destination (the SDK then targets the change address).
   * No priority fee on a sweep (the wallet-core rejects sender/receiver-pays fees there). Returns
   * the batch transaction ids.
   */
  async consolidate(password: string): Promise<string[]> {
    // Same reason as send(): bypass the empty UtxoContext and sweep via the manual path.
    return this.consolidateManual(password);
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

  /** How many receive/change indices to derive when building the key map. */
  private static readonly MANUAL_SCAN_DEPTH = 20;
  /** Max inputs per transaction. A P2PK input is ~1100 mass and the standard cap is ~100k, so ~84
   *  inputs fit; stay safely under. Consolidating >this many UTXOs takes several runs. */
  private static readonly MAX_TX_INPUTS = 80;
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
    for (let i = 0; i < depth; i++) {
      const rk = gen.receiveKey(i);
      map.set(rk.toAddress(this._networkId).toString(), rk);
      const ck = gen.changeKey(i);
      map.set(ck.toAddress(this._networkId).toString(), ck);
    }
    return map;
  }

  /**
   * SAFETY GATE for the manual tx path. Reuses the already-derived key map (no extra mnemonic
   * reveal): if our known receive address isn't reproduced by the derivation, the keys are wrong
   * and we MUST NOT sign — abort loudly instead of broadcasting an invalid/garbage transaction.
   */
  private assertDerivationMatches(keyMap: Map<string, kaspa.PrivateKey>): void {
    // Every funded address the node reports must be coverable by a derived key. At minimum the
    // primary receive address must be in the derived set.
    const probe = this.receiveAddress ?? this.accountAddresses[0];
    if (probe && !keyMap.has(probe)) {
      throw new Error(
        "Key derivation does not match this wallet's addresses — aborting to avoid signing with " +
          "the wrong keys. (Manual transaction path disabled for safety.)"
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
  private async fetchEntries(): Promise<any[]> {
    if (!this.wallet) throw new Error("Wallet is locked.");
    if (this.accountAddresses.length === 0) {
      throw new Error("No addresses to scan for UTXOs.");
    }
    const res = await this.wallet.rpc.getUtxosByAddresses(
      this.accountAddresses
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
    // Spend the LARGEST UTXOs first. A send/estimate is capped at MAX_TX_INPUTS inputs per tx, so
    // taking the node's arbitrary order could slice off dust and fail to fund a send that is well
    // within the real balance. Largest-first guarantees one tx funds the maximum possible amount.
    mapped.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
    return mapped;
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

    const keyMap = this.deriveKeyMap(password);
    this.assertDerivationMatches(keyMap);
    const keys = Array.from(keyMap.values());
    const entries = await this.fetchEntries();
    if (entries.length === 0) throw new Error("No spendable UTXOs found.");

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
    });
    return [txid];
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
    if (change < 0n) throw new Error("Amount + network fee exceeds your balance.");
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
   * CONTEXT-FREE consolidate (compound). Sweeps up to MAX_TX_INPUTS UTXOs into ONE output back to
   * our own change/receive address, via the synchronous build path (no async Generator → no hang).
   * If there are more UTXOs than fit one tx, this does one batch; re-run to keep compounding.
   */
  async consolidateManual(password: string): Promise<string[]> {
    if (!this.wallet || !this._accountId) throw new Error("Wallet is locked.");
    if (this.conn !== "connected" || !this.synced) {
      throw new Error("Connect to a synced node first.");
    }

    const keyMap = this.deriveKeyMap(password);
    this.assertDerivationMatches(keyMap);
    const keys = Array.from(keyMap.values());
    const entries = await this.fetchEntries();
    if (entries.length < 2) {
      throw new Error("Nothing to consolidate (need at least 2 UTXOs).");
    }

    const changeAddress = this.receiveAddress ?? this.accountAddresses[0];
    if (!changeAddress) throw new Error("No change/receive address available.");

    // No explicit outputs → everything (minus fee) goes to the single change output = a compound.
    const txid = await this.buildSignSubmitSync(entries, changeAddress, [], keys, 0n);
    // A consolidate is a self-send: the funds stay yours, so record it as a neutral (no +/-) entry
    // showing the amount swept in this batch (the inputs actually used, capped at MAX_TX_INPUTS).
    const swept = entries
      .slice(0, WalletService.MAX_TX_INPUTS)
      .reduce((s, e) => s + BigInt(e.amount), 0n);
    this.recordLocalActivity({
      id: txid,
      type: "consolidate",
      direction: "other",
      amountSompi: swept,
      timestamp: Date.now(),
    });
    return [txid];
  }

  /**
   * READ-ONLY snapshot of the account's UTXO set straight from the node (getUtxosByAddresses).
   * Used to show "how many UTXOs you have / how many remain" during consolidation. Touches nothing
   * — no signing, no state change on the wallet/node/chain.
   */
  async utxoStats(): Promise<{ count: number; totalSompi: bigint }> {
    if (!this.wallet || this.accountAddresses.length === 0) {
      return { count: 0, totalSompi: 0n };
    }
    const res = await this.wallet.rpc.getUtxosByAddresses(this.accountAddresses);
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
    this.emit();
    return addr;
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
    } catch {
      /* non-fatal */
    }
  }

  private normalizeRecord(tx: any): HistoryEntry {
    const type: string =
      tx?.type ?? tx?.data?.type ?? "unknown";
    // Prefer the top-level record value; fall back to the inner variant value.
    const rawValue = tx?.value ?? tx?.data?.data?.value ?? 0n;
    let amountSompi = 0n;
    try {
      amountSompi = BigInt(rawValue);
    } catch {
      amountSompi = 0n;
    }
    let timestamp: number | undefined;
    const ms = tx?.unixtimeMsec;
    if (ms !== undefined && ms !== null) {
      try {
        timestamp = Number(BigInt(ms));
      } catch {
        timestamp = undefined;
      }
    }
    const lower = String(type).toLowerCase();
    const direction: HistoryEntry["direction"] = INCOMING_TYPES.has(lower)
      ? "in"
      : OUTGOING_TYPES.has(lower)
      ? "out"
      : "other";
    return { id: tx?.id ?? "", type: lower, direction, amountSompi, timestamp };
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
