import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePagedSearch } from "../lib/usePagedSearch";
import { Pager, TxSearch, TypeFilter } from "../components/Pager";
import { wallet, formatKrxShort, HistoryEntry, ReceivedEntry } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import { HolderRewardPanel } from "../components/HolderReward";
import { ModalKey } from "../lib/nav";

const HISTORY_POLL_MS = 15_000;
/**
 * How long a refresh may run before it is allowed to say so.
 *
 * A local node answers these reads in well under this, so the common case shows NO indicator
 * at all: announcing a refresh that is already over is what produced a flicker rather than
 * feedback. Only a refresh slow enough to be noticed gets to draw attention to itself.
 */
const BUSY_DELAY_MS = 250;

/**
 * The kinds each list can be filtered to.
 *
 * "mining" is a coinbase payout — the node paying the miner directly, which on a mining
 * wallet is nearly every incoming row. "received" is the rest: someone actually paying this
 * wallet. On the way out, "consolidation" is a sweep of the wallet's own UTXOs into fewer
 * (it leaves and returns to the same wallet, so it is not really a payment) and "sent" is a
 * genuine outgoing transfer. Telling those apart is the whole point of the filter: a real
 * payment among 400 payouts is otherwise unfindable.
 */
type RecvKind = "all" | "mining" | "received";
type SentKind = "all" | "sent" | "consolidation";

const recvKindOf = (u: ReceivedEntry): Exclude<RecvKind, "all"> =>
  u.isCoinbase ? "mining" : "received";

// `type` is what we recorded ourselves when submitting: "consolidate" for a sweep batch,
// "outgoing" for a send. Anything else is treated as a plain send rather than dropped, so an
// unrecognised record can never become invisible.
const sentKindOf = (tx: HistoryEntry): Exclude<SentKind, "all"> =>
  tx.type === "consolidate" ? "consolidation" : "sent";

const countOf = <T,>(items: T[], pred: (t: T) => boolean) =>
  items.reduce((n, t) => (pred(t) ? n + 1 : n), 0);

export function Home({ onOpen }: { onOpen: (key: ModalKey) => void }) {
  const w = useWalletState();
  const [diag, setDiag] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  async function runDiagnose() {
    setDiagBusy(true);
    try {
      const d = await wallet.diagnose();
      setDiag(JSON.stringify(d, null, 2));
    } catch (e) {
      setDiag(e instanceof Error ? e.message : "diagnose failed");
    } finally {
      setDiagBusy(false);
    }
  }

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [received, setReceived] = useState<ReceivedEntry[]>([]);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Signatures of what is already on screen. A poll that returns the same rows must not replace
  // the arrays: a new array identity re-runs the filter, the pager and every row for nothing,
  // and doing that every 15 seconds is visible as a twitch.
  const histSig = useRef("");
  const recvSig = useRef("");
  const loadedOnce = useRef(false);
  const busyTimer = useRef<number | null>(null);

  const inFlight = useRef(false);

  const refreshHistory = useCallback(async (opts?: { silent?: boolean }) => {
    if (!wallet.isOpen) return;
    // A poll that lands on top of a running read is pointless, so it is dropped. A CLICK or a
    // wallet switch is never dropped: skipping those would leave the user looking at stale rows
    // with no way to ask again.
    if (opts?.silent && inFlight.current) return;
    inFlight.current = true;
    // The 15s poll and the balance-changed trigger are SILENT. They are not something the user
    // asked for, so they must not move a pixel of chrome; they just swap data in if it changed.
    // The first load is the exception to the delay: with no rows yet the panel would otherwise
    // show its empty-state copy for 250ms before "Loading…", which is a worse flash.
    const announce = !opts?.silent;
    if (announce && !loadedOnce.current) {
      setLoadingHistory(true);
    } else if (announce) {
      busyTimer.current = window.setTimeout(() => setLoadingHistory(true), BUSY_DELAY_MS);
    }
    try {
      // Also retry the direct-UTXO balance read (no-op if a real balance event already landed).
      void wallet.refreshBalanceFromUtxos();
      // Other wallets have no live event stream (only the active account is activated), so their
      // balances are polled here to keep the all-wallets total honest.
      void wallet.refreshWalletTotals();
      const h = await wallet.history(50);
      const hs = h.map((t) => `${t.id}:${t.amountSompi}:${t.timestamp ?? 0}:${t.type}`).join("|");
      if (hs !== histSig.current) {
        histSig.current = hs;
        setHistory(h);
      }
      const r = await wallet.receivedEntries();
      const rs = r.map((u) => `${u.txid}:${u.daaScore}:${u.amountSompi}`).join("|");
      if (rs !== recvSig.current) {
        recvSig.current = rs;
        setReceived(r);
      }
      setHistoryErr(null);
    } catch (e) {
      setHistoryErr(
        e instanceof Error ? e.message : "Could not load activity."
      );
    } finally {
      inFlight.current = false;
      loadedOnce.current = true;
      if (busyTimer.current !== null) {
        window.clearTimeout(busyTimer.current);
        busyTimer.current = null;
      }
      setLoadingHistory(false);
    }
  }, []);

  // Both lists get the same treatment from the same hook — the txid search and the numbered pager
  // behave identically on each, and two copies would be two places to drift. Declared above the
  // effects so the wallet-switch reset below can clear them.
  //
  // The kind filter runs BEFORE the hook, so the search, the counts and the page count all
  // describe the same subset — filtering after paging would page over rows the user cannot see.
  const [recvKind, setRecvKind] = useState<RecvKind>("all");
  const [sentKind, setSentKind] = useState<SentKind>("all");
  const recvShown = useMemo(
    () => (recvKind === "all" ? received : received.filter((u) => recvKindOf(u) === recvKind)),
    [received, recvKind]
  );
  const sentShown = useMemo(
    () => (sentKind === "all" ? history : history.filter((tx) => sentKindOf(tx) === sentKind)),
    [history, sentKind]
  );
  const recv = usePagedSearch(recvShown, (u) => u.txid);
  const sent = usePagedSearch(sentShown, (tx) => tx.id);
  const resetRecv = recv.reset;
  const resetSent = sent.reset;
  // A different kind is a different result set, so the old page number means nothing against it —
  // same reasoning as a new query, which the hook already resets for.
  const pickRecv = (k: RecvKind) => {
    setRecvKind(k);
    recv.setPage(1);
  };
  const pickSent = (k: SentKind) => {
    setSentKind(k);
    sent.setPage(1);
  };

  // Initial load + polling, and a hard reset whenever the ACTIVE WALLET changes.
  //
  // The reset matters: the balance-change effect below cannot catch a switch, because switching
  // sets the balance to 0 and 0 -> 0 is not a change. Without this the previous wallet's Received
  // and Sent rows stayed on screen under the new wallet's name.
  useEffect(() => {
    setHistory([]);
    setReceived([]);
    setHistoryErr(null);
    // Clear the search too: a query left over from the previous wallet would filter the new
    // wallet's rows down to nothing, which reads as "this wallet has no transactions".
    resetRecv();
    resetSent();
    setRecvKind("all");
    setSentKind("all");
    histSig.current = "";
    recvSig.current = "";
    loadedOnce.current = false;
    void refreshHistory();
    const id = window.setInterval(() => void refreshHistory({ silent: true }), HISTORY_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshHistory, w.accountId, resetRecv, resetSent]);

  // Refresh when balance moves (cheap heuristic for "something happened"). Silent, and it skips
  // its own mount: the effect above already loaded, and refreshBalanceFromUtxos moves the
  // balance, so without the guard every refresh immediately triggered a second one.
  const balanceSeen = useRef(false);
  useEffect(() => {
    if (!balanceSeen.current) {
      balanceSeen.current = true;
      return;
    }
    void refreshHistory({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.balance.mature, w.balance.pending]);

  const canTransact = w.conn === "connected" && w.synced;

  // The hero sits in a ~400px rail, so a 14-digit balance would wrap mid-number. Step the type
  // down by length instead: every balance stays on one line, and short ones keep the big number.
  // While a switch is in flight the new wallet's balance has not been read yet. Showing the 0 it
  // holds meanwhile reads as "this wallet is empty", which is alarming and wrong.
  const switching = w.switchingWallet !== null;
  const balanceText = formatKrxShort(w.balance.mature);
  const balanceType =
    balanceText.length > 12
      ? "text-2xl"
      : balanceText.length > 9
        ? "text-3xl"
        : "text-4xl";

  const connText =
    w.conn === "connected"
      ? w.synced
        ? "connected · node synced"
        : "connected · node syncing…"
      : w.conn === "connecting"
        ? "connecting…"
        : "disconnected";
  const connDot =
    w.conn === "connected"
      ? w.synced
        ? "bg-keryx-green"
        : "bg-keryx-warn"
      : w.conn === "connecting"
        ? "bg-keryx-warn animate-pulse"
        : "bg-keryx-error";

  return (
    <div className="flex flex-1 flex-col">
      {/* Connection / node status */}
      <div className="card mb-5 flex items-center justify-between px-4 py-2 text-[11px]">
        <span className="flex items-center gap-2 text-keryx-text">
          <span className={`h-1.5 w-1.5 rounded-full ${connDot}`} />
          {connText}
        </span>
        <span className="flex items-center gap-3">
          <span className="num text-keryx-dim">
            {w.scanning
              ? "scanning wallet…"
              : w.nodeDaa != null
                ? `DAA ${w.nodeDaa.toString()}`
                : ""}
          </span>
          {/* Refresh lives here, not in a panel header: one click re-reads the balance, every
              wallet's total AND both logs, so hanging it off "Sent" claimed a scope it never had
              and pushed that panel's search field out of line with Received's. */}
          {/* The label is CONSTANT. Swapping "Refresh" for "Refreshing…" changed the button's
              width, which shoved the DAA counter beside it — and it fired on the 15s poll too,
              so the bar twitched on its own every 15 seconds. Progress is a dot that is always
              in the layout (transparent when idle), so nothing reflows when it lights up. */}
          <button
            className="btn-ghost px-2.5 py-0.5 text-[10px]"
            onClick={() => void refreshHistory()}
            aria-busy={loadingHistory}
            title="Re-read balances from the node and the transaction history from the explorer"
          >
            <span
              className={`mr-1.5 inline-block h-1 w-1 rounded-full align-middle ${
                loadingHistory ? "animate-pulse bg-keryx-green" : "bg-transparent"
              }`}
            />
            Refresh
          </button>
        </span>
      </div>

      {/* Global for the same reason the button is: the read it reports on feeds both logs. */}
      {historyErr && <p className="mb-5 text-xs text-keryx-error">{historyErr}</p>}

      {/* Node has no UTXO index → balances are impossible. This is the #1 reason for a 0 balance. */}
      {w.conn === "connected" && w.hasUtxoIndex === false && (
        <div className="mb-5 rounded-sm border border-keryx-error/40 bg-keryx-error/10 px-4 py-2.5 text-xs leading-relaxed text-keryx-error">
          <b className="mr-1">!</b> This node was started{" "}
          <b>
            without <code className="code-inline">--utxoindex</code>
          </b>
          . A light wallet cannot read balances or UTXOs from it. Restart the node with{" "}
          <code className="code-inline">--utxoindex</code> (and{" "}
          <code className="code-inline">--rpclisten-borsh</code>) or point the wallet at a node
          that has it.
        </div>
      )}

      {/* Diagnostics: dev-only. It exposes the full address list + per-address balances + raw UTXO
          dump (no secrets, but pasting it publicly deanonymizes the wallet), so it's gated behind
          import.meta.env.DEV and stripped from production builds. Even in dev it's only surfaced
          when there's likely a problem (connected but no balance and not still scanning). */}
      {import.meta.env.DEV &&
        w.conn === "connected" &&
        !w.scanning &&
        w.balance.mature === 0n &&
        w.balance.pending === 0n && (
        <div className="mb-5 text-right">
          <button
            className="text-[10px] uppercase tracking-label text-keryx-dim hover:text-keryx-green"
            onClick={() => void runDiagnose()}
            disabled={diagBusy}
          >
            {diagBusy ? "Diagnosing…" : "Diagnose balance"}
          </button>
          {diag && (
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-keryx-border bg-keryx-bg/60 p-3 text-left text-[10px] leading-snug text-keryx-text">
              {diag}
            </pre>
          )}
        </div>
      )}

      {/* Wide windows: the balance sits in a sticky left rail with the two logs beside it,
          instead of everything queueing up in one 672px column down the middle of the
          screen. Below lg it collapses back to a single column, so the 420px minimum
          window size still works. */}
      <div className="grid gap-5 lg:flex-1 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] xl:grid-cols-[minmax(340px,420px)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Balance hero */}
        <div className="panel lg:sticky lg:top-[70px] lg:self-start">
          {/* The wallet's name used to be appended here, because nothing else on screen said
              whose balance this was. The header now carries it, in the slot the window title bar
              was wasting — repeating it two elements later would just move the duplication. */}
          <p className="section-label">Balance</p>
          {/* slashed-zero: at this size JetBrains Mono's dotted zero fills in and a balance
              of 0 reads as a solid block. */}
          <p
            className={`num glow slashed-zero whitespace-nowrap font-bold leading-tight tracking-tight ${
              switching ? "text-keryx-dim" : "text-keryx-bright"
            } ${balanceType}`}
          >
            {switching ? "—" : balanceText}{" "}
            <span className="text-lg font-medium tracking-label text-keryx-dim">KRX</span>
          </p>
          {switching && (
            <p className="mt-2 flex items-center gap-2 text-xs text-keryx-mid">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keryx-green" />
              Reading this wallet's coins…
            </p>
          )}
          {!switching && w.balance.pending > 0n && (
            <p className="num mt-2 text-sm text-keryx-warn">
              +{formatKrxShort(w.balance.pending)} KRX pending
            </p>
          )}

          {/* Mining status for this address, from the explorer API. Renders nothing for a
              non-mining address. */}
          <HolderRewardPanel />

          <div className="mt-6 flex gap-3">
            <button
              className="btn-primary flex-1"
              onClick={() => onOpen("send")}
              disabled={!canTransact}
              title={canTransact ? undefined : "Connect to a node first"}
            >
              Send
            </button>
            <button className="btn-ghost flex-1" onClick={() => onOpen("receive")}>
              Receive
            </button>
          </div>
          <button
            className="btn-ghost mt-3 w-full"
            onClick={() => onOpen("chat")}
            disabled={!canTransact}
            title={canTransact ? undefined : "Connect to a node first"}
          >
            Ask the network · AI inference
          </button>
          {/* Distinguish the two reasons, the way Send's own banner does: saying "not connected"
              while the status line above reads "connected · node syncing…" is just wrong. */}
          {!canTransact && (
            <p className="mt-3 text-xs text-keryx-warn">
              {w.conn === "connected"
                ? "Node is still syncing. Sending is disabled until it catches up."
                : "Not connected. Sending is disabled."}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {canTransact && w.balance.mature > 0n && (
              <button
                className="btn-ghost flex-1"
                onClick={() => onOpen("consolidate")}
                title="Combine many small UTXOs into fewer (handy for mining payouts)"
              >
                Consolidate
              </button>
            )}
            <button
              className="btn-ghost flex-1"
              onClick={() => onOpen("addresses")}
              title="See your addresses and switch the active account"
            >
              Addresses
            </button>
          </div>
        </div>

        {/* Under xl these two stack inside the second column; at xl `display: contents`
            dissolves this wrapper so each becomes a column of the outer grid. */}
        <div className="grid gap-5 xl:contents">
          {/* Received — incoming transactions for the ACTIVE address, from the explorer API. */}
          <div className="panel flex flex-col">
            <p className="section-label mb-3">Received</p>
            {received.length === 0 ? (
              switching || loadingHistory ? (
                <p className="my-auto px-2 py-6 text-center text-xs text-keryx-dim">Loading…</p>
              ) : (
              <p className="my-auto px-2 py-6 text-center text-xs leading-relaxed text-keryx-dim">
                No incoming transactions on this address yet.
              </p>
              )
            ) : (
              <>
                {/* The kind split needs the coinbase flag; without it every row would count as
                    "received", so the filter is only offered when the API reports the flag. */}
                {received.some((u) => u.isCoinbase !== undefined) && (
                <TypeFilter
                  value={recvKind}
                  onChange={pickRecv}
                  options={[
                    { key: "all", label: "all", count: received.length },
                    {
                      key: "mining",
                      label: "mining",
                      count: countOf(received, (u) => recvKindOf(u) === "mining"),
                    },
                    {
                      key: "received",
                      label: "received",
                      count: countOf(received, (u) => recvKindOf(u) === "received"),
                    },
                  ]}
                />
                )}
                <TxSearch value={recv.query} onChange={recv.setQuery} matches={recv.total} />
                {recv.rows.length === 0 ? (
                  // Reachable two ways, and they need different words: an empty log took the
                  // branch above, so here it is either a query that matches nothing or a kind
                  // this wallet has none of. Saying "no match" instead of showing an empty list
                  // is what stops either one from reading as "my deposits are gone".
                  <p className="my-auto px-2 py-6 text-center text-xs text-keryx-dim">
                    {recv.query !== ""
                      ? "No received transaction matches that id."
                      : recvKind === "mining"
                        ? "No mining payouts on this wallet."
                        : "Nothing received from anyone else — only mining payouts."}
                  </p>
                ) : (
                  <ul
                    className={`divide-y divide-keryx-border transition-opacity duration-200 ${
                      loadingHistory ? "opacity-60" : "opacity-100"
                    }`}
                  >
                    {recv.rows.map((u) => (
                      <ReceivedRow key={u.txid} u={u} />
                    ))}
                  </ul>
                )}
                <Pager page={recv.page} pageCount={recv.pageCount} onPage={recv.setPage} />
              </>
            )}
          </div>

          {/* Sent — this account's own outgoing txs (send/consolidate) */}
          <div className="panel flex flex-col">
            <p className="section-label mb-3">Sent</p>
            {history.length === 0 ? (
              <p className="my-auto py-8 text-center text-sm text-keryx-dim">
                {switching || loadingHistory ? "Loading…" : "No transactions yet."}
              </p>
            ) : (
              <>
                <TypeFilter
                  value={sentKind}
                  onChange={pickSent}
                  options={[
                    { key: "all", label: "all", count: history.length },
                    {
                      key: "sent",
                      label: "sent",
                      count: countOf(history, (tx) => sentKindOf(tx) === "sent"),
                    },
                    {
                      key: "consolidation",
                      label: "consolidation",
                      count: countOf(history, (tx) => sentKindOf(tx) === "consolidation"),
                    },
                  ]}
                />
                <TxSearch value={sent.query} onChange={sent.setQuery} matches={sent.total} />
                {sent.rows.length === 0 ? (
                  <p className="my-auto px-2 py-6 text-center text-xs text-keryx-dim">
                    {sent.query !== ""
                      ? "No sent transaction matches that id."
                      : sentKind === "consolidation"
                        ? "No consolidation sweeps from this wallet."
                        : "No payments sent from this wallet."}
                  </p>
                ) : (
                  <ul
                    className={`divide-y divide-keryx-border transition-opacity duration-200 ${
                      loadingHistory ? "opacity-60" : "opacity-100"
                    }`}
                  >
                    {sent.rows.map((tx, i) => (
                      <ActivityRow key={tx.id || `tx-${i}`} tx={tx} />
                    ))}
                  </ul>
                )}
                <Pager page={sent.page} pageCount={sent.pageCount} onPage={sent.setPage} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function ActivityRow({ tx }: { tx: HistoryEntry }) {
  const [copied, setCopied] = useState(false);
  const sign = tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : "";
  const color =
    tx.direction === "in"
      ? "text-keryx-green"
      : tx.direction === "out"
      ? "text-keryx-error"
      : "text-keryx-text";
  const shortId = tx.id ? `${tx.id.slice(0, 8)}…${tx.id.slice(-6)}` : "—";
  const when = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : null;

  function copyId() {
    if (!tx.id) return;
    navigator.clipboard?.writeText(tx.id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm capitalize text-keryx-ink">{tx.type}</p>
        {tx.id ? (
          <button
            type="button"
            onClick={copyId}
            title="Copy transaction ID"
            className="num text-xs text-keryx-dim hover:text-keryx-green"
          >
            {copied ? "Copied ✓" : shortId}
          </button>
        ) : (
          <p className="num text-xs text-keryx-dim">{shortId}</p>
        )}
        {when && <p className="text-xs text-keryx-dim">{when}</p>}
      </div>
      <span className={`num shrink-0 text-sm font-semibold ${color}`}>
        {sign}
        {formatKrxShort(tx.amountSompi)} KRX
      </span>
    </li>
  );
}

function ReceivedRow({ u }: { u: ReceivedEntry }) {
  const [copied, setCopied] = useState(false);
  const shortId = u.txid ? `${u.txid.slice(0, 8)}…${u.txid.slice(-6)}` : "—";
  const explorer = u.txid ? `https://keryx-labs.com/tx/${u.txid}` : undefined;
  function copyId() {
    if (!u.txid) return;
    navigator.clipboard?.writeText(u.txid).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm text-keryx-ink">
          {u.isCoinbase === true ? "Mining reward" : "Received"}
        </p>
        <div className="flex items-center gap-2">
          {explorer ? (
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="num text-xs text-keryx-dim hover:text-keryx-green"
            >
              {shortId} ↗
            </a>
          ) : (
            <span className="num text-xs text-keryx-dim">{shortId}</span>
          )}
          {u.txid && (
            <button
              type="button"
              onClick={copyId}
              className="text-xs text-keryx-dim hover:text-keryx-green"
            >
              {copied ? "Copied ✓" : "copy"}
            </button>
          )}
        </div>
        {u.daaScore > 0n && (
          <p className="num mt-0.5 text-xs text-keryx-dim">DAA {u.daaScore.toLocaleString()}</p>
        )}
      </div>
      <span className="num shrink-0 text-sm font-semibold text-keryx-green">
        +{formatKrxShort(u.amountSompi)} KRX
      </span>
    </li>
  );
}
