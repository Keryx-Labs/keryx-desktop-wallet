import { useCallback, useEffect, useState } from "react";
import { wallet, formatKrxShort, HistoryEntry, ReceivedEntry } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import { Send } from "./Send";
import { Receive } from "./Receive";
import { Consolidate } from "./Consolidate";
import { Addresses } from "./Addresses";

const HISTORY_POLL_MS = 15_000;

export function Home() {
  const w = useWalletState();
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [showConsolidate, setShowConsolidate] = useState(false);
  const [showAddresses, setShowAddresses] = useState(false);
  const [sentShown, setSentShown] = useState(10);
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
  const [recvShown, setRecvShown] = useState(10);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const refreshHistory = useCallback(async () => {
    if (!wallet.isOpen) return;
    setLoadingHistory(true);
    try {
      // Also retry the direct-UTXO balance read (no-op if a real balance event already landed).
      void wallet.refreshBalanceFromUtxos();
      const h = await wallet.history(50);
      setHistory(h);
      setReceived(await wallet.receivedEntries());
      setHistoryErr(null);
    } catch (e) {
      setHistoryErr(
        e instanceof Error ? e.message : "Could not load activity."
      );
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Initial load + polling.
  useEffect(() => {
    void refreshHistory();
    const id = window.setInterval(() => void refreshHistory(), HISTORY_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshHistory]);

  // Refresh when balance moves (cheap heuristic for "something happened").
  useEffect(() => {
    void refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.balance.mature, w.balance.pending]);

  const canTransact = w.conn === "connected" && w.synced;

  const connText =
    w.conn === "connected"
      ? w.synced
        ? "Connected · node synced"
        : "Connected · node syncing…"
      : w.conn === "connecting"
        ? "Connecting…"
        : "Disconnected";
  const connDot =
    w.conn === "connected"
      ? w.synced
        ? "bg-keryx-green"
        : "bg-amber-400"
      : w.conn === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-red-500";

  return (
    <div className="mx-auto max-w-2xl p-5">
      {/* Connection / node status */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-keryx-border bg-black/20 px-4 py-2 text-xs">
        <span className="flex items-center gap-2 text-emerald-100/80">
          <span className={`h-2 w-2 rounded-full ${connDot}`} />
          {connText}
        </span>
        <span className="font-mono text-emerald-200/50">
          {w.scanning
            ? "scanning wallet…"
            : w.nodeDaa != null
              ? `DAA ${w.nodeDaa.toString()}`
              : ""}
        </span>
      </div>

      {/* Node has no UTXO index → balances are impossible. This is the #1 reason for a 0 balance. */}
      {w.conn === "connected" && w.hasUtxoIndex === false && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-200">
          ⚠️ This node was started <b>without <code>--utxoindex</code></b>. A light wallet cannot
          read balances or UTXOs from it. Restart the node with <code>--utxoindex</code> (and{" "}
          <code>--rpclisten-borsh</code>) or point the wallet at a node that has it.
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
        <div className="mb-4 text-right">
          <button
            className="text-xs text-emerald-200/40 hover:text-keryx-green"
            onClick={() => void runDiagnose()}
            disabled={diagBusy}
          >
            {diagBusy ? "Diagnosing…" : "Diagnose balance"}
          </button>
          {diag && (
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-keryx-border bg-black/40 p-3 text-left text-[10px] leading-snug text-emerald-100/70">
              {diag}
            </pre>
          )}
        </div>
      )}

      {/* Balance hero */}
      <div className="panel">
        <p className="label">Balance</p>
        <p className="text-5xl font-bold leading-tight text-keryx-green">
          {formatKrxShort(w.balance.mature)}{" "}
          <span className="text-xl font-medium text-emerald-200/50">KRX</span>
        </p>
        {w.balance.pending > 0n && (
          <p className="mt-2 text-sm text-amber-300">
            +{formatKrxShort(w.balance.pending)} KRX pending
          </p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            className="btn-primary flex-1"
            onClick={() => setShowSend(true)}
            disabled={!canTransact}
            title={canTransact ? undefined : "Connect to a node first"}
          >
            Send
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => setShowReceive(true)}
          >
            Receive
          </button>
        </div>
        {!canTransact && (
          <p className="mt-3 text-xs text-amber-300/80">
            Not connected — sending is disabled.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          {canTransact && w.balance.mature > 0n && (
            <button
              className="btn-ghost flex-1 text-xs"
              onClick={() => setShowConsolidate(true)}
              title="Combine many small UTXOs into fewer (handy for mining payouts)"
            >
              Consolidate UTXOs
            </button>
          )}
          <button
            className="btn-ghost flex-1 text-xs"
            onClick={() => setShowAddresses(true)}
            title="See your addresses and switch the active account"
          >
            My addresses
          </button>
        </div>
      </div>

      {/* Received — incoming deposits for the ACTIVE account (per-account, persistent forward log). */}
      <div className="panel mt-5">
        <p className="label mb-3">Received</p>
        {received.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-emerald-200/40">
            Incoming deposits for this account are recorded here from now on and stay even
            after you spend them.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-keryx-border">
              {received.slice(0, recvShown).map((u) => (
                <ReceivedRow key={`${u.txid}:${u.index}`} u={u} />
              ))}
            </ul>
            {received.length > recvShown && (
              <button
                className="mt-3 w-full text-center text-xs text-emerald-200/50 hover:text-keryx-green"
                onClick={() => setRecvShown((n) => n + 10)}
              >
                Show more ({received.length - recvShown})
              </button>
            )}
          </>
        )}
      </div>

      {/* Sent — this account's own outgoing txs (send/consolidate) */}
      <div className="panel mt-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="label mb-0">Sent</p>
          <button
            className="btn-ghost px-3 py-1 text-xs"
            onClick={() => void refreshHistory()}
            disabled={loadingHistory}
          >
            {loadingHistory ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {historyErr && (
          <p className="mb-3 text-sm text-red-400">{historyErr}</p>
        )}

        {history.length === 0 ? (
          <p className="py-8 text-center text-sm text-emerald-200/40">
            No transactions yet.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-keryx-border">
              {history.slice(0, sentShown).map((tx, i) => (
                <ActivityRow key={tx.id || `tx-${i}`} tx={tx} />
              ))}
            </ul>
            {history.length > sentShown && (
              <button
                className="mt-3 w-full text-center text-xs text-emerald-200/50 hover:text-keryx-green"
                onClick={() => setSentShown((n) => n + 10)}
              >
                Show more ({history.length - sentShown})
              </button>
            )}
          </>
        )}
      </div>

      {showSend && <Send onClose={() => setShowSend(false)} />}
      {showReceive && <Receive onClose={() => setShowReceive(false)} />}
      {showConsolidate && (
        <Consolidate onClose={() => setShowConsolidate(false)} />
      )}
      {showAddresses && <Addresses onClose={() => setShowAddresses(false)} />}
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
      ? "text-red-300"
      : "text-emerald-100/70";
  const shortId = tx.id ? `${tx.id.slice(0, 8)}…${tx.id.slice(-6)}` : "—";
  const when = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : null;

  function copyId() {
    if (!tx.id) return;
    navigator.clipboard?.writeText(tx.id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <li className="flex items-center justify-between py-3">
      <div className="min-w-0">
        <p className="text-sm capitalize text-emerald-100/90">{tx.type}</p>
        {tx.id ? (
          <button
            type="button"
            onClick={copyId}
            title="Copy transaction ID"
            className="font-mono text-xs text-emerald-200/50 hover:text-keryx-green"
          >
            {copied ? "Copied ✓" : shortId}
          </button>
        ) : (
          <p className="font-mono text-xs text-emerald-200/40">{shortId}</p>
        )}
        {when && <p className="text-xs text-emerald-200/30">{when}</p>}
      </div>
      <span className={`shrink-0 font-mono text-sm font-semibold ${color}`}>
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
    <li className="flex items-center justify-between py-3">
      <div className="min-w-0">
        <p className="text-sm text-emerald-100/90">
          {u.isCoinbase ? "Mining reward" : "Received"}
        </p>
        <div className="flex items-center gap-2">
          {explorer ? (
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-emerald-200/50 hover:text-keryx-green"
            >
              {shortId} ↗
            </a>
          ) : (
            <span className="font-mono text-xs text-emerald-200/40">{shortId}</span>
          )}
          {u.txid && (
            <button
              type="button"
              onClick={copyId}
              className="text-xs text-emerald-200/40 hover:text-keryx-green"
            >
              {copied ? "Copied ✓" : "copy"}
            </button>
          )}
        </div>
        {u.timestamp && (
          <p className="mt-0.5 text-xs text-emerald-200/30">
            {new Date(u.timestamp).toLocaleString()}
          </p>
        )}
      </div>
      <span className="shrink-0 font-mono text-sm font-semibold text-keryx-green">
        +{formatKrxShort(u.amountSompi)} KRX
      </span>
    </li>
  );
}
