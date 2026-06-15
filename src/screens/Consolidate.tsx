import { useCallback, useEffect, useRef, useState } from "react";
import { wallet, formatKrx } from "../lib/wallet";

type Stats = { count: number; totalSompi: bigint };

// Consolidate (compound) UTXOs: sends your many small UTXOs back to yourself in as few
// transactions as possible (the SDK batches automatically). Useful for miners with lots of small
// payouts. It pays the network fee; the balance stays yours. Everything here is safe: the only
// state-changing call is the consolidate itself (a self-send); the UTXO counts are read-only.
export function Consolidate({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [txids, setTxids] = useState<string[] | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [startCount, setStartCount] = useState<number | null>(null);
  const [diag, setDiag] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  async function runDiag() {
    setDiag("running diagnostics… (up to ~15s)");
    try {
      setDiag(JSON.stringify(await wallet.diagnose(), null, 2));
    } catch (e) {
      setDiag(e instanceof Error ? e.message : "diagnose failed");
    }
  }

  const loadStats = useCallback(async () => {
    try {
      const s = await wallet.utxoStats();
      setStats(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  // Initial UTXO snapshot when the modal opens.
  useEffect(() => {
    void loadStats();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [loadStats]);

  async function run() {
    setErr(null);
    if (!password) {
      setErr("Enter your password.");
      return;
    }
    setBusy(true);
    try {
      const before = stats?.count ?? null;
      setStartCount(before);
      const ids = await wallet.consolidate(password);
      setPassword("");
      setTxids(ids);
      // Watch the UTXO count drop live as the batches confirm, then stop once
      // there is nothing left to consolidate (a single UTXO or none).
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(() => {
        void loadStats().then((s) => {
          if (s && s.count <= 1 && pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
        });
      }, 5000) as unknown as number;
    } catch (e) {
      setPassword("");
      setErr(
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : "Could not consolidate."
      );
    } finally {
      setBusy(false);
    }
  }

  const count = stats?.count ?? 0;
  // Progress: from the count we started with down toward 1 (fully consolidated).
  const progress =
    startCount != null && startCount > 1
      ? Math.min(100, Math.max(0, Math.round(((startCount - count) / (startCount - 1)) * 100)))
      : count <= 1
        ? 100
        : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel w-full max-w-md">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-keryx-green">Consolidate UTXOs</h2>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Live UTXO snapshot (read-only) */}
        <div className="mb-4 rounded-xl border border-keryx-border bg-black/20 p-3">
          <div className="flex items-center justify-between text-xs text-emerald-100/70">
            <span>Coins (UTXOs) on this wallet</span>
            <span className="font-mono text-keryx-green">
              {stats ? stats.count : "…"}
            </span>
          </div>
          {stats && (
            <div className="mt-1 flex items-center justify-between text-[11px] text-emerald-200/40">
              <span>Total</span>
              <span className="font-mono">{formatKrx(stats.totalSompi)} KRX</span>
            </div>
          )}
          {(txids || (startCount != null && startCount > 1)) && (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full bg-keryx-green transition-all duration-700"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-right text-[10px] text-emerald-200/40">
                {count <= 1
                  ? "fully consolidated"
                  : `${count} UTXOs remaining${startCount ? ` (started at ${startCount})` : ""}`}
              </p>
            </div>
          )}
        </div>

        {!txids ? (
          <>
            <p className="mb-4 text-sm text-emerald-100/70">
              Combines your many small UTXOs into fewer, larger ones by sending them back to
              yourself. Handy if you receive lots of small payments (e.g. mining). It pays the
              network fee and may take several batch transactions — your balance stays yours.
            </p>
            <label className="label">Confirm with your password</label>
            <input
              className="input mb-4"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Wallet password"
              autoComplete="current-password"
              autoFocus
              disabled={busy}
            />
            {err && <p className="mb-3 text-sm text-red-400">{err}</p>}
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn-primary flex-1"
                onClick={run}
                disabled={busy || !password || count <= 1}
                title={count <= 1 ? "Nothing to consolidate (1 or fewer UTXOs)" : undefined}
              >
                {busy ? "Consolidating…" : count <= 1 ? "Nothing to do" : "Consolidate"}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="mb-2 text-lg font-bold text-keryx-green">Submitted ✓</p>
            <p className="mb-3 text-sm text-emerald-100/70">
              {txids.length} batch transaction{txids.length === 1 ? "" : "s"} sent. The bar above
              updates live as they confirm and the UTXO count drops. The consolidated balance
              becomes spendable after it matures.
            </p>
            <div className="mb-5 max-h-32 space-y-1 overflow-y-auto">
              {txids.map((id) => (
                <code
                  key={id}
                  className="block break-all rounded-lg bg-black/30 p-2 text-xs text-keryx-green/80"
                >
                  {id}
                </code>
              ))}
            </div>
            <button className="btn-primary w-full" onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {/* Debug aid: if consolidation seems stuck, this shows what the node vs the wallet engine
            see (read-only). Helps pin down a stuck send. */}
        <div className="mt-4 border-t border-keryx-border pt-3 text-right">
          <button
            className="text-[10px] text-emerald-200/30 hover:text-keryx-green"
            onClick={() => void runDiag()}
          >
            Run diagnostics
          </button>
          {diag && (
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-keryx-border bg-black/40 p-2 text-left text-[10px] leading-snug text-emerald-100/70">
              {diag}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
