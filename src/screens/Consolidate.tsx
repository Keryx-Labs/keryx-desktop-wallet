import { useCallback, useEffect, useRef, useState } from "react";
import { wallet, formatKrx, formatKrxShort } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";

type Stats = { count: number; totalSompi: bigint };
type Cost = { utxoCount: number; txCount: number; rounds: number; feeSompi: bigint };

// Consolidate (compound) UTXOs: sweeps many small UTXOs back to yourself in as few transactions as
// the per-transaction input limit allows. Useful for miners with lots of small payouts.
//
// The run lives on the WalletService (wallet.consolidateRun), NOT in this component: a 40k-UTXO
// wallet takes several minutes and closing this window must not abandon it — nor leave the user
// guessing whether it is still going.
export function Consolidate({ onClose }: { onClose: () => void }) {
  const w = useWalletState();
  const run = w.consolidateRun;

  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Results come from the run on the service, not local state: the run outlives this component, so
  // reopening the window after it finished must still show what happened. A failed run with zero
  // submitted transactions also lands here, so its error is shown instead of a blank form.
  const finished =
    run && !run.running && (run.txids.length > 0 || run.phase === "failed") ? run : null;

  const [stats, setStats] = useState<Stats | null>(null);
  const [cost, setCost] = useState<Cost | null>(null);
  const [costBusy, setCostBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [diag, setDiag] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const busy = run?.running === true;

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

  // Initial snapshot + cost estimate. Poll while a run is active so the count drops live; the
  // interval is cleared on unmount but the RUN itself keeps going (it lives on the service).
  useEffect(() => {
    void loadStats();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [loadStats]);

  useEffect(() => {
    if (!busy) return;
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => void loadStats(), 5000) as unknown as number;
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [busy, loadStats]);

  const loadCost = useCallback(async () => {
    setCostBusy(true);
    setErr(null);
    try {
      setCost(await wallet.estimateConsolidateCost());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not estimate the cost.");
    } finally {
      setCostBusy(false);
    }
  }, []);

  async function start() {
    setErr(null);
    if (!password) {
      setErr("Enter your password.");
      return;
    }
    try {
      await wallet.consolidate(password);
      setPassword("");
      void loadStats();
    } catch (e) {
      setPassword("");
      setErr(
        e instanceof Error ? e.message : typeof e === "string" ? e : "Could not consolidate."
      );
      void loadStats();
    }
  }

  const count = stats?.count ?? 0;
  const startCount = run?.startCount ?? null;
  const progress =
    startCount != null && startCount > 1
      ? Math.min(100, Math.max(0, Math.round(((startCount - count) / (startCount - 1)) * 100)))
      : count <= 1
        ? 100
        : 0;

  const phaseLabel: Record<string, string> = {
    building: "reading your UTXOs",
    submitting: "submitting transactions",
    waiting: "waiting for confirmation + maturity",
    done: "finished",
    stopped: "stopped",
    failed: "failed",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel max-h-[92vh] w-full max-w-md overflow-y-auto">
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
            <span className="font-mono text-keryx-green">{stats ? stats.count : "…"}</span>
          </div>
          {stats && (
            <div className="mt-1 flex items-center justify-between text-[11px] text-emerald-200/40">
              <span>Total</span>
              <span className="font-mono">{formatKrxShort(stats.totalSompi)} KRX</span>
            </div>
          )}
          {run && (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full bg-keryx-green transition-all duration-700"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-start justify-between gap-2 text-[10px] text-emerald-200/50">
                <span>
                  {busy ? (
                    <>
                      <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keryx-green align-middle" />
                      Round {run.round}/{run.round + run.roundsEstimate - 1} ·{" "}
                      {phaseLabel[run.phase] ?? run.phase}
                    </>
                  ) : (
                    <>Run {phaseLabel[run.phase] ?? run.phase}</>
                  )}
                </span>
                <span className="whitespace-nowrap font-mono">
                  {run.txsSubmitted} tx{run.txsSubmitted === 1 ? "" : "s"}
                  {run.txsFailed > 0 ? ` · ${run.txsFailed} failed` : ""}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-emerald-200/40">
                {startCount != null && startCount > 1
                  ? `${startCount} → ${count} UTXOs · fees so far ${formatKrxShort(run.feePaidSompi)} KRX`
                  : `${count} UTXOs`}
              </p>
            </div>
          )}
        </div>

        {/* A running consolidation: status + Stop. Closing this window does not stop it. */}
        {busy ? (
          <>
            <p className="mb-3 text-sm leading-relaxed text-emerald-100/70">
              Consolidating. This keeps running if you close this window — reopen it any time to see
              where it is. Stopping finishes the transaction in flight and then halts; UTXOs already
              swept stay swept.
            </p>
            {run?.lastError && (
              <div className="mb-3 max-h-24 overflow-y-auto rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-amber-200">
                  {run.lastError}
                </p>
              </div>
            )}
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={onClose}>
                Run in background
              </button>
              <button
                className="btn-ghost flex-1 border-red-500/40 text-red-300 hover:bg-red-500/10"
                onClick={() => wallet.stopConsolidate()}
                disabled={run?.stopRequested}
              >
                {run?.stopRequested ? "Stopping…" : "Stop"}
              </button>
            </div>
          </>
        ) : finished ? (
          <div>
            <p
              className={`mb-2 text-center text-lg font-bold ${
                finished.phase === "failed" ? "text-red-400" : "text-keryx-green"
              }`}
            >
              {finished.phase === "failed"
                ? "Stopped on an error"
                : finished.phase === "stopped"
                  ? "Stopped"
                  : "Done ✓"}
            </p>
            <p className="mb-3 text-center text-sm leading-relaxed text-emerald-100/70">
              {finished.txids.length} transaction{finished.txids.length === 1 ? "" : "s"} submitted,{" "}
              {formatKrx(finished.feePaidSompi)} KRX in fees
              {finished.txsFailed > 0 ? ` · ${finished.txsFailed} failed` : ""}.{" "}
              {count <= 1
                ? "Everything is consolidated into a single UTXO."
                : `${count} UTXOs remain — run it again if that is still more than you want.`}{" "}
              The consolidated balance becomes spendable after it matures.
            </p>

            {/* Whatever the node said, verbatim and wrapped. Transactions already submitted are real
                regardless of this error — say so rather than implying everything was rolled back. */}
            {finished.lastError && (
              <div className="mb-4 max-h-32 overflow-y-auto rounded-lg border border-red-500/40 bg-red-500/10 p-2">
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-red-300">
                  {finished.lastError}
                </p>
              </div>
            )}

            {finished.txids.length > 0 && (
              <div className="mb-5 max-h-32 space-y-1 overflow-y-auto">
                {finished.txids.slice(0, 50).map((id) => (
                  <code
                    key={id}
                    className="block break-all rounded-lg bg-black/30 p-2 text-xs text-keryx-green/80"
                  >
                    {id}
                  </code>
                ))}
                {finished.txids.length > 50 && (
                  <p className="text-[11px] text-emerald-200/40">
                    …and {finished.txids.length - 50} more
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                className="btn-ghost flex-1 text-xs"
                onClick={() => {
                  wallet.clearConsolidateRun();
                  setCost(null);
                  setConfirmed(false);
                  setErr(null);
                  void loadStats();
                }}
                disabled={count <= 1}
                title={count <= 1 ? "Nothing left to consolidate" : undefined}
              >
                Consolidate again
              </button>
              <button className="btn-primary flex-1" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm leading-relaxed text-emerald-100/70">
              Combines your many small UTXOs into one by sending them back to yourself. Handy for
              mining payouts. It runs in rounds — each round sweeps everything it can in parallel, so
              even a very large wallet finishes in a few rounds.
            </p>

            {/* Fee estimate BEFORE committing. Every transaction pays the network minimum, and a big
                miner wallet needs hundreds or thousands of them — that total must not be a surprise. */}
            {!cost ? (
              <button
                className="btn-ghost mb-4 w-full text-xs"
                onClick={() => void loadCost()}
                disabled={costBusy || count <= 1}
              >
                {costBusy ? "Estimating…" : "Estimate what this will cost"}
              </button>
            ) : (
              <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="mb-2 text-xs font-medium text-amber-200">Estimated cost</p>
                <dl className="space-y-1 text-[11px] text-amber-200/90">
                  <div className="flex justify-between">
                    <dt>UTXOs to sweep</dt>
                    <dd className="font-mono">{cost.utxoCount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Transactions needed</dt>
                    <dd className="font-mono">{cost.txCount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Rounds</dt>
                    <dd className="font-mono">{cost.rounds}</dd>
                  </div>
                  <div className="flex justify-between border-t border-amber-500/30 pt-1 font-semibold">
                    <dt>Total network fee</dt>
                    <dd className="font-mono">{formatKrx(cost.feeSompi)} KRX</dd>
                  </div>
                </dl>
                <p className="mt-2 text-[10px] leading-relaxed text-amber-200/60">
                  An upper bound: immature mining rewards are skipped this run, so the real total can
                  be lower. Each transaction pays the network minimum — the count is set by the
                  per-transaction input limit, not by us.
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] text-amber-200">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I accept paying up to {formatKrx(cost.feeSompi)} KRX in network fees.
                </label>
              </div>
            )}

            <label className="label">Confirm with your password</label>
            <input
              className="input mb-4"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Wallet password"
              autoComplete="current-password"
              autoFocus
            />

            {/* Node rejections are long single-line strings; without wrapping they used to blow the
                modal layout apart. */}
            {err && (
              <div className="mb-3 max-h-32 overflow-y-auto rounded-lg border border-red-500/40 bg-red-500/10 p-2">
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-red-300">
                  {err}
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary flex-1"
                onClick={() => void start()}
                disabled={!password || count <= 1 || !cost || !confirmed}
                title={
                  count <= 1
                    ? "Nothing to consolidate (1 or fewer UTXOs)"
                    : !cost
                      ? "Estimate the cost first"
                      : !confirmed
                        ? "Accept the fee to continue"
                        : undefined
                }
              >
                {count <= 1 ? "Nothing to do" : "Consolidate"}
              </button>
            </div>
          </>
        )}

        {/* Debug aid (dev-only): shows what the node vs the wallet engine see (read-only) to pin
            down a stuck send. Exposes the full address list + raw UTXO dump (no secrets, but
            deanonymizing if pasted publicly), so it's gated behind import.meta.env.DEV and stripped
            from production builds. */}
        {import.meta.env.DEV && (
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
        )}
      </div>
    </div>
  );
}
