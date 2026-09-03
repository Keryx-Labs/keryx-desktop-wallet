import { useCallback, useMemo, useState } from "react";

/** Rows per page. Matches the old "show more (+10)" step, and fits a panel without scrolling. */
export const PAGE_SIZE = 10;

/**
 * Normalise a txid query for matching: lowercase, and strip everything that is not hex.
 *
 * Stripping non-hex is what makes a pasted **displayed** id work. Rows show `741eb852…9630da`,
 * and users select and copy what they can see far more often than they find the copy button — so
 * the ellipsis, stray spaces and a `#` prefix all have to survive being pasted in. The fragments
 * are kept separately so the two halves can be matched in order rather than as one impossible
 * substring (no txid literally contains the middle of the display form).
 */
function parseQuery(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^0-9a-f]+/)
    .filter(Boolean);
}

/** True if `txid` matches the parsed query: every fragment present, in order. */
function matches(txid: string, fragments: string[]): boolean {
  const id = txid.toLowerCase();
  let from = 0;
  for (const f of fragments) {
    const at = id.indexOf(f, from);
    if (at === -1) return false;
    from = at + f.length;
  }
  return true;
}

/**
 * Search-by-txid plus numbered pagination over one list.
 *
 * Filtering happens BEFORE paging, so the page count describes the result the user is looking at
 * and page 1 always holds the best-known matches. The page is clamped rather than reset when the
 * list shrinks under it (a background refresh adding or dropping rows must not yank the reader
 * back to the top), but a NEW query does reset to page 1 — the old page number means nothing
 * against a different result set.
 */
export function usePagedSearch<T>(items: T[], txidOf: (item: T) => string) {
  const [query, setQueryRaw] = useState("");
  const [page, setPage] = useState(1);

  const fragments = useMemo(() => parseQuery(query), [query]);
  const filtered = useMemo(
    () => (fragments.length === 0 ? items : items.filter((it) => matches(txidOf(it), fragments))),
    // `txidOf` is a stable accessor in practice; re-filtering on every render of an inline arrow
    // would be wasteful, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, fragments]
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // Stable, so a caller can reset from an effect without the effect re-running every render.
  const reset = useCallback(() => {
    setQueryRaw("");
    setPage(1);
  }, []);

  return {
    reset,
    query,
    setQuery: (q: string) => {
      setQueryRaw(q);
      setPage(1);
    },
    page: current,
    setPage,
    pageCount,
    rows,
    /** Size of the filtered result, which is what the pager and any count should describe. */
    total: filtered.length,
  };
}

/**
 * Page numbers to render for `page` of `pageCount`, with `null` standing for a gap.
 *
 * Always shows the first and last page, plus a window around the current one, so the list of
 * buttons stays a fixed width no matter how long the history gets — a wallet that has mined for a
 * week has hundreds of pages, and rendering them all would push the panel off screen.
 */
export function pageItems(page: number, pageCount: number): Array<number | null> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const window = new Set<number>([1, pageCount, page]);
  for (const p of [page - 1, page + 1]) {
    if (p > 1 && p < pageCount) window.add(p);
  }
  // Keep the row a constant width: near an end the window is one-sided, so borrow from the other.
  if (page <= 3) [2, 3, 4].forEach((p) => window.add(p));
  if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((p) => window.add(p));

  const sorted = [...window].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
}
