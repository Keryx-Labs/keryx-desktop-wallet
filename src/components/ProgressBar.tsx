/** The subset of a ConsolidateRun the bar needs, so this module stays free of wallet imports. */
type RunLike = { phase: string; startCount: number; remaining: number };

/**
 * Percent of a consolidation sweep completed. One UTXO is the floor — you can never consolidate
 * the last one away — so the denominator is startCount - 1.
 *
 * startCount is 0 from the moment the run is created until its first UTXO read lands, and the
 * service emits in between. That zero means "not measured yet", NOT "nothing to do": reading it
 * as a measurement made every run render a full bar for an instant and then snap back to 0.
 */
export function consolidateProgress(startCount: number, remaining: number): number {
  if (startCount <= 0) return 0; // no measurement yet
  if (startCount === 1) return 100; // a lone UTXO is already consolidated
  const pct = Math.round(((startCount - remaining) / (startCount - 1)) * 100);
  return Math.min(100, Math.max(0, pct));
}

/**
 * Percent to show for a run, phase included.
 *
 * A finished run reads 100 regardless of the arithmetic. "done" is only set for a sweep that got
 * as far as it can (a run that ran out of fee budget stays "stopped"), yet the ratio could still
 * land at 98-99%: once the run ends the caller recomputes from a FRESH UTXO count, which may
 * include coins the sweep could never spend — an immature coinbase output, or a deposit that
 * arrived meanwhile. That showed a completed run as a stuck 99% bar. "stopped" and "failed" keep
 * their real ratio, because they genuinely did not finish.
 */
export function consolidateRunPercent(run: RunLike): number {
  if (run.phase === "done") return 100;
  // Always the run's OWN remaining count, never the wallet's live one: a stopped or failed run
  // recomputed from live stats kept drifting after it ended — creeping to 100% as coins were
  // spent, or falling as new ones arrived.
  return consolidateProgress(run.startCount, run.remaining);
}

/**
 * The site's segmented reward bar, reused for progress. The slim default is chrome (the
 * background-run strip in the header area); `tall` is the one Consolidate's modal shows,
 * with the percentage read out inside the fill.
 */
export function ProgressBar({
  percent,
  tall,
}: {
  percent: number;
  tall?: boolean;
}) {
  return (
    <div
      className={
        tall
          ? "h-[42px] w-full overflow-hidden rounded-sm border border-keryx-border"
          : "h-1.5 w-full overflow-hidden border-t border-keryx-border"
      }
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="flex h-full items-center justify-center text-[11px] font-bold text-keryx-onCta transition-all duration-700"
        style={{
          width: `${percent}%`,
          background: "linear-gradient(180deg,#2bf055,#00c72e)",
        }}
      >
        {/* Below ~18% the fill is too narrow to hold the label without clipping. */}
        {tall && percent >= 18 ? `${percent}%` : null}
      </div>
    </div>
  );
}
