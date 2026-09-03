import { useCallback, useEffect, useMemo, useState } from "react";
import { wallet, formatKrxShort, WalletEntry } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import { Modal } from "../components/Modal";
import { SeedBackup } from "../components/SeedBackup";
import { AliasField } from "../components/AliasField";

/*
 * Wallet manager. Each entry is a WALLET — its own recovery phrase, its own account, its own
 * addresses — and they all live in one SDK wallet file, which is what makes them share a single
 * password: changing it in Settings re-encrypts every one of them at once.
 *
 * Adding a wallet asks for that password again, because the app deliberately never keeps it in
 * memory after unlock.
 */

type View = "list" | "create" | "import";

export function Addresses({ onClose }: { onClose: () => void }) {
  const w = useWalletState();
  const [view, setView] = useState<View>("list");
  // Returning to the list with the new wallet marked active is the real confirmation, but say it
  // in words too: adding a wallet is consequential enough that "did that work?" should not be a
  // question the user has to answer by reading the list.
  const [notice, setNotice] = useState<string | null>(null);

  function done(msg?: string) {
    setNotice(msg ?? null);
    setView("list");
  }

  return (
    <Modal
      title={
        view === "create"
          ? "Create a new wallet"
          : view === "import"
            ? "Import an existing wallet"
            : `My wallets (${w.walletCount})`
      }
      size="lg"
      onClose={onClose}
    >
      {view === "list" && (
        <WalletList
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onClose={onClose}
          onCreate={() => {
            setNotice(null);
            setView("create");
          }}
          onImport={() => {
            setNotice(null);
            setView("import");
          }}
        />
      )}
      {view === "create" && <CreateWallet onDone={done} />}
      {view === "import" && <ImportWallet onDone={done} />}
    </Modal>
  );
}

// --- list -----------------------------------------------------------------------------------

function WalletList({
  notice,
  onDismissNotice,
  onClose,
  onCreate,
  onImport,
}: {
  notice: string | null;
  onDismissNotice: () => void;
  onClose: () => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  const w = useWalletState();
  const [err, setErr] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // accountId whose remove link was clicked, awaiting the inline confirmation.
  const [removing, setRemoving] = useState<string | null>(null);

  // Pull fresh per-wallet balances for the total, and run the active wallet's address scan — the
  // scan is what adopts a funded derived address into the watched set, so a mining payout that
  // landed on a later index still counts towards the balance.
  useEffect(() => {
    void wallet.refreshWalletTotals();
    void wallet.listAccounts(30).catch(() => []);
  }, []);

  async function pick(entry: WalletEntry) {
    if (entry.accountId === w.accountId) return;
    setErr(null);
    setSwitching(entry.accountId);
    try {
      await wallet.selectWallet(entry.accountId);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not switch wallet.");
    } finally {
      setSwitching(null);
    }
  }

  function remove(entry: WalletEntry) {
    setErr(null);
    try {
      wallet.hideWallet(entry.accountId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove.");
    }
    setRemoving(null);
  }

  function restore(accountId: string) {
    setErr(null);
    try {
      wallet.restoreWallet(accountId);
      // Its balance came back as "—": the entry is rebuilt from the cached descriptor, which
      // carries no balance, and the polling loop skipped it while it was hidden.
      void wallet.refreshWalletTotals();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not restore.");
    }
  }

  function saveName(entry: WalletEntry) {
    try {
      wallet.renameWallet(entry.accountId, draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not rename.");
    }
    setRenaming(null);
  }

  const total = w.totalBalanceSompi;

  return (
    <>
      <div className="card mb-4 flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="section-label mb-0">Total · all wallets</p>
          <p className="num mt-1 text-xl font-bold text-keryx-bright">
            {formatKrxShort(total)}{" "}
            <span className="text-xs font-medium tracking-label text-keryx-dim">KRX</span>
          </p>
        </div>
        <span className="badge shrink-0">
          {w.walletCount} wallet{w.walletCount === 1 ? "" : "s"}
        </span>
      </div>

      {notice && (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-sm border border-keryx-green/40 bg-keryx-green/10 p-3">
          <p className="text-sm leading-relaxed text-keryx-bright">{notice}</p>
          <button
            className="shrink-0 text-[10px] uppercase tracking-label text-keryx-dim hover:text-keryx-green"
            onClick={onDismissNotice}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <p className="mb-3 text-xs leading-relaxed text-keryx-text">
        Each wallet has its <b className="text-keryx-ink">own recovery phrase</b>. They all share
        this app's password — changing it in Settings changes it for every wallet.
      </p>

      <ul className="mb-4 space-y-2">
        {w.wallets.map((entry) => {
          const isActive = entry.accountId === w.accountId;
          // The active wallet reports its live balance; the others their last polled one.
          const bal = isActive ? w.balance.mature : entry.balanceSompi;
          return (
            <li
              key={entry.accountId}
              className={`rounded-sm border p-3 ${
                isActive
                  ? "border-keryx-green bg-keryx-green/10"
                  : "card-hover border-keryx-border bg-keryx-green/[0.03]"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {renaming === entry.accountId ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="input py-1 text-sm"
                        value={draft}
                        maxLength={40}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveName(entry);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                      <button className="btn-ghost shrink-0 px-2 py-1 text-[10px]" onClick={() => saveName(entry)}>
                        Save
                      </button>
                    </div>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2 text-sm text-keryx-ink">
                      {entry.alias}
                      {isActive && (
                        <span className="badge-on px-2 py-0 text-[9px] uppercase tracking-label">
                          active
                        </span>
                      )}
                      {!entry.hasSeed && (
                        <span
                          className="badge px-2 py-0 text-[9px] uppercase tracking-label text-keryx-warn"
                          title="No phrase stored for this wallet — reveal and per-wallet backup are unavailable."
                        >
                          no phrase
                        </span>
                      )}
                      <button
                        className="text-[10px] uppercase tracking-label text-keryx-dim underline decoration-dotted underline-offset-2 hover:text-keryx-green"
                        onClick={() => {
                          setDraft(entry.alias);
                          setRenaming(entry.accountId);
                        }}
                      >
                        rename
                      </button>
                      {/* Only where removing is actually possible: the active wallet and the last
                          remaining one are refused by the service, so offering the link there
                          would just produce an error the user cannot act on. */}
                      {!isActive && w.wallets.length > 1 && (
                        <button
                          className="text-[10px] uppercase tracking-label text-keryx-dim underline decoration-dotted underline-offset-2 hover:text-keryx-warn"
                          onClick={() => setRemoving(entry.accountId)}
                        >
                          remove
                        </button>
                      )}
                    </span>
                  )}
                  <code className="num mt-1 block break-all text-[11px] text-keryx-dim">
                    {entry.receiveAddress ?? "—"}
                  </code>
                </div>
                <span className="num shrink-0 text-sm font-semibold text-keryx-bright">
                  {bal == null ? "—" : `${formatKrxShort(bal)} KRX`}
                </span>
              </div>
              {removing === entry.accountId ? (
                <div className="mt-2 rounded-sm border border-keryx-warn/40 bg-keryx-warn/10 p-2">
                  {/* The whole point of saying this: "remove" in a wallet reads as "destroy", and
                      a user who believes their coins are at stake will not use the button at all.
                      Nothing is deleted here — not the phrase, not the account, not the file. */}
                  <p className="text-[11px] leading-snug text-keryx-ink">
                    Remove <b>{entry.alias}</b> from this list?
                  </p>
                  {/* keryx-muted on the warn tint is the palette's weakest pair and was not
                      readable at 10px — this sentence is the whole reassurance, so it gets a
                      legible tone and size. */}
                  <p className="mt-1 text-[11px] leading-snug text-keryx-text">
                    Nothing is deleted: the recovery phrase, the account and its balance stay
                    exactly as they are, the address keeps receiving and mining, and you can put it
                    back below at any time.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button className="btn-ghost py-1 text-[10px]" onClick={() => setRemoving(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn-ghost py-1 text-[10px] text-keryx-warn"
                      onClick={() => remove(entry)}
                    >
                      Remove from list
                    </button>
                  </div>
                </div>
              ) : (
                !isActive && (
                  <button
                    className="btn-ghost mt-2 w-full py-1.5 text-[10px]"
                    onClick={() => void pick(entry)}
                    disabled={switching !== null}
                  >
                    {switching === entry.accountId ? "Switching…" : "Use this wallet"}
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>

      {/* Restoring has to be visible from here, or "remove" is a one-way door in practice even
          though nothing was destroyed. */}
      {w.hiddenWalletIds.length > 0 && (
        <div className="mb-4 rounded-sm border border-keryx-border bg-keryx-green/[0.03] p-3">
          <p className="section-label mb-2">
            Removed from this list ({w.hiddenWalletIds.length})
          </p>
          <ul className="space-y-1.5">
            {w.hiddenWalletIds.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2">
                <code className="num min-w-0 flex-1 truncate text-[10px] text-keryx-dim">
                  {wallet.hiddenWalletLabel(id)}
                </code>
                <button
                  className="shrink-0 text-[10px] uppercase tracking-label text-keryx-dim underline decoration-dotted underline-offset-2 hover:text-keryx-green"
                  onClick={() => restore(id)}
                >
                  restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && <p className="mb-3 text-sm text-keryx-error">{err}</p>}

      <div className="grid grid-cols-2 gap-2">
        <button className="btn-ghost" onClick={onCreate}>
          + Create wallet
        </button>
        <button className="btn-ghost" onClick={onImport}>
          + Import phrase
        </button>
      </div>

      <OtherAddresses />
    </>
  );
}

/**
 * The active wallet's other addresses. Kept because a miner's payouts can land on a derived index
 * the switcher never listed, and this is how such an address gets adopted and spendable — but
 * folded away, since the wallets above are what the screen is now about.
 */
function OtherAddresses() {
  const w = useWalletState();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<
    Array<{ address: string; balanceSompi: bigint; kind: "receive" | "change"; isActive: boolean }>
  >([]);

  const load = useCallback(async () => {
    try {
      setRows(await wallet.listAccounts(30));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const extra = rows.filter((r) => r.address !== w.receiveAddress);

  return (
    <div className="mt-4 border-t border-keryx-border pt-3">
      <button
        className="text-[10px] uppercase tracking-label text-keryx-dim hover:text-keryx-green"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "− " : "+ "}
        Other addresses in “{w.activeWallet?.alias ?? "this wallet"}”
      </button>
      {open && (
        <>
          {extra.length === 0 ? (
            <p className="mt-2 text-xs text-keryx-dim">
              No other addresses hold funds in this wallet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-keryx-border">
              {extra.map((r) => (
                <li key={r.address} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <code className="num block break-all text-[11px] text-keryx-dim">
                      {r.address}
                    </code>
                    {r.kind === "change" && (
                      <span className="text-[10px] uppercase tracking-label text-keryx-dim">
                        change
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="num text-xs text-keryx-ink">
                      {formatKrxShort(r.balanceSompi)} KRX
                    </span>
                    <button
                      className="btn-ghost px-2 py-1 text-[10px]"
                      onClick={() => {
                        try {
                          wallet.useAccount(r.address);
                        } catch {
                          /* a run is in flight; the list stays as it is */
                        }
                      }}
                    >
                      Use
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// --- create ---------------------------------------------------------------------------------

function CreateWallet({ onDone }: { onDone: (msg?: string) => void }) {
  const [step, setStep] = useState<"form" | "backup">("form");
  const [alias, setAlias] = useState("");
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const words = useMemo(() => (phrase ? phrase.split(" ") : []), [phrase]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toBackup() {
    setErr(null);
    try {
      setPhrase(wallet.create()); // local only — nothing is persisted until it is confirmed
      setStep("backup");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not generate a phrase.");
    }
  }

  async function commit() {
    if (!phrase) return;
    setBusy(true);
    setErr(null);
    try {
      await wallet.addWallet(password, phrase, alias);
      setPassword("");
      onDone(`Created “${wallet.activeWallet?.alias ?? alias}” — it is now the active wallet.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the wallet.");
      setBusy(false);
      setStep("form");
    }
  }

  if (step === "backup" && phrase) {
    return (
      <>
        {busy && <p className="mb-3 text-sm text-keryx-mid">Creating…</p>}
        <SeedBackup
          words={words}
          onConfirmed={() => void commit()}
          onCancel={() => onDone()}
          cancelLabel="Back"
        />
        {err && <p className="mt-3 text-sm text-keryx-error">{err}</p>}
      </>
    );
  }

  return (
    <>
      <p className="mb-3 text-xs leading-relaxed text-keryx-text">
        This creates a wallet with a <b className="text-keryx-ink">new recovery phrase</b>, which
        you will be asked to back up next. It uses the same password as your other wallets.
      </p>
      <AliasField value={alias} onChange={setAlias} />
      <label className="label mt-3">Your wallet password</label>
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="The password you unlock with"
        autoComplete="current-password"
      />
      {err && <p className="mt-3 text-sm text-keryx-error">{err}</p>}
      <div className="mt-5 flex justify-between">
        <button className="btn-ghost" onClick={() => onDone()}>
          Cancel
        </button>
        <button className="btn-primary" onClick={toBackup} disabled={!password}>
          Show recovery phrase
        </button>
      </div>
    </>
  );
}

// --- import ---------------------------------------------------------------------------------

function ImportWallet({ onDone }: { onDone: (msg?: string) => void }) {
  const [alias, setAlias] = useState("");
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const wordCount = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const validLen = wordCount === 12 || wordCount === 24;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await wallet.addWallet(password, phrase, alias);
      setPassword("");
      setPhrase("");
      onDone(
        `Imported “${wallet.activeWallet?.alias ?? alias}” — it is now the active wallet. Its balance fills in as the node scans it.`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not import the wallet.");
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mb-3 text-xs leading-relaxed text-keryx-text">
        Add a wallet you already own by its recovery phrase. It joins this app under the{" "}
        <b className="text-keryx-ink">same password</b> as your other wallets — the phrase's own
        wallet elsewhere is unaffected.
      </p>
      <label className="label">Recovery phrase (12 or 24 words)</label>
      <textarea
        className="input h-24 resize-none"
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="word1 word2 word3 …"
      />
      <p className="mt-1 text-xs text-keryx-dim">
        {wordCount} word{wordCount === 1 ? "" : "s"}
        {wordCount > 0 && !validLen ? " (expected 12 or 24)" : ""}
      </p>
      <AliasField value={alias} onChange={setAlias} placeholder="e.g. Cold storage" />
      <label className="label mt-3">Your wallet password</label>
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="The password you unlock with"
        autoComplete="current-password"
      />
      {err && <p className="mt-3 text-sm text-keryx-error">{err}</p>}
      <div className="mt-5 flex justify-between">
        <button className="btn-ghost" onClick={() => onDone()} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={() => void submit()}
          disabled={!validLen || !password || busy}
        >
          {busy ? "Importing…" : "Import wallet"}
        </button>
      </div>
    </>
  );
}
