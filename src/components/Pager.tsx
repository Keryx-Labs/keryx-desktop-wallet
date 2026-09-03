import { useState } from "react";
import { pageItems } from "../lib/usePagedSearch";

/** Search-by-txid field for a transaction list. Filters as you type; no submit. */
export function TxSearch({
  value,
  onChange,
  matches,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Result size, shown while a query is active so the count belongs to what is on screen. */
  matches: number;
}) {
  return (
    <div className="mb-3">
      <div className="relative">
        <input
          className="input py-1.5 pr-16 text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search transaction id"
          spellCheck={false}
          aria-label="Search transaction id"
        />
        {/* Clearing has to be one click: a 64-character id is tedious to select and delete, and a
            stale query silently hides every other row. */}
        {value !== "" && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-label text-keryx-dim hover:text-keryx-green"
            onClick={() => onChange("")}
            aria-label="Clear search"
          >
            clear
          </button>
        )}
      </div>
      {value !== "" && (
        <p className="mt-1 text-[10px] uppercase tracking-label text-keryx-dim">
          {matches === 0 ? "no match" : `${matches} match${matches === 1 ? "" : "es"}`}
        </p>
      )}
    </div>
  );
}

/**
 * Segmented type filter for a transaction list.
 *
 * The two panels split incoming from outgoing, but each still mixes two kinds of thing that
 * a miner reads very differently: coinbase payouts versus someone actually paying you, and
 * a real spend versus a consolidation sweep moving coins between your own addresses. A
 * mining wallet produces hundreds of the first and a handful of the second, so without this
 * the interesting rows are buried under payouts.
 *
 * Counts are on the pills because the useful question is usually "how many of these are
 * there", answered before any click. A kind with no rows is still shown, disabled: a
 * missing pill would read as a broken filter, a "0" states the fact.
 */
export function TypeFilter<K extends string>({
  value,
  onChange,
  options,
}: {
  value: K;
  onChange: (v: K) => void;
  options: Array<{ key: K; label: string; count: number }>;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by type">
      {options.map(({ key, label, count }) => {
        const on = key === value;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            disabled={count === 0 && !on}
            aria-pressed={on}
            className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-label transition-colors ${
              on
                ? "border-keryx-green bg-keryx-green/10 text-keryx-bright"
                : "border-keryx-border text-keryx-dim enabled:hover:border-keryx-green enabled:hover:text-keryx-green"
            } disabled:cursor-default disabled:opacity-50`}
          >
            {label} <span className="num ml-0.5 tracking-normal">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Numbered pager with first/last jumps and a go-to-page field.
 *
 * `mt-auto` is what pins it to the BOTTOM of the panel: the panels are flex columns stretched to a
 * common height by the grid, so without it the row floats up under a short list and the two
 * panels' pagers land at different heights. Pinned, they line up regardless of how many rows each
 * list happens to hold.
 *
 * Renders nothing for a single page — a lone "1" is noise, and the panels are dense already.
 */
export function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  const [goto, setGoto] = useState("");
  if (pageCount <= 1) return null;
  const items = pageItems(page, pageCount);
  const step = (to: number) => onPage(Math.min(pageCount, Math.max(1, to)));

  const submitGoto = () => {
    const n = parseInt(goto, 10);
    // Out of range clamps rather than erring: "999" plainly means "the end", and refusing it
    // would be pedantry over a request whose intent is unambiguous.
    if (Number.isFinite(n)) step(n);
    setGoto("");
  };

  return (
    <div className="mt-auto pt-3">
      {/* Wraps: at the 420px minimum window the arrows, numbers and field cannot share one line. */}
      <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
        <PagerButton onClick={() => step(1)} disabled={page === 1} label="First page">
          «
        </PagerButton>
        <PagerButton onClick={() => step(page - 1)} disabled={page === 1} label="Previous page">
          ‹
        </PagerButton>
        {items.map((p, i) =>
          p === null ? (
            // Not a button: the gap stands for pages that exist but are not worth a target here.
            <span key={`gap-${i}`} className="px-1 text-[10px] text-keryx-dim" aria-hidden>
              ·&#8202;·&#8202;·
            </span>
          ) : (
            <PagerButton key={p} onClick={() => step(p)} current={p === page} label={`Page ${p}`}>
              {p}
            </PagerButton>
          )
        )}
        <PagerButton onClick={() => step(page + 1)} disabled={page === pageCount} label="Next page">
          ›
        </PagerButton>
        <PagerButton onClick={() => step(pageCount)} disabled={page === pageCount} label="Last page">
          »
        </PagerButton>
      </nav>

      <div className="mt-2 flex items-center justify-center gap-2">
        {/* A span, not a label: the input carries its own aria-label, and a <label> with no
            htmlFor and no wrapped control is a lie to a screen reader. */}
        <span className="text-[10px] uppercase tracking-label text-keryx-dim">go to</span>
        <input
          className="input w-14 px-2 py-0.5 text-center text-[11px]"
          value={goto}
          onChange={(e) => setGoto(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitGoto();
            if (e.key === "Escape") setGoto("");
          }}
          inputMode="numeric"
          placeholder={String(page)}
          title={`Type a page and press Enter (1 to ${pageCount})`}
          aria-label={`Go to page, 1 to ${pageCount}. Press Enter to go.`}
        />
        <span className="num text-[10px] text-keryx-dim">of {pageCount}</span>
      </div>
    </div>
  );
}

function PagerButton({
  children,
  onClick,
  disabled,
  current,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  current?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      // Three states, all legible, each a clear step apart: current `bright` (14:1), available
      // `mid` (9:1), unavailable `dim` (5.5:1). The unavailable state used `keryx-border`, which
      // measures 1.1:1 on the card — invisible, and an invisible arrow reads as a broken render
      // rather than as a disabled one.
      className={`num min-w-[22px] rounded-sm border px-1.5 py-0.5 text-[11px] transition-colors ${
        current
          ? "border-keryx-green bg-keryx-green/10 text-keryx-bright"
          : "border-keryx-border text-keryx-mid hover:border-keryx-green hover:text-keryx-green"
      } disabled:cursor-default disabled:border-keryx-border disabled:text-keryx-dim disabled:hover:border-keryx-border disabled:hover:text-keryx-dim`}
    >
      {children}
    </button>
  );
}
