/** Hairline rule and one line of 10px tracked-out copy, matching the site's footer. */
export function Footer({ note }: { note?: string }) {
  return (
    <footer className="mt-auto border-t border-keryx-border">
      {/* Same max-w-content as the header and <main>, so the rule spans the window but the
          text stays aligned with the columns above it. */}
      <div className="mx-auto w-full max-w-content px-5 py-3 lg:px-6">
        <span className="text-[10px] tracking-widest text-keryx-dim">
          © 2026 Keryx Labs
          {note ? <span className="text-keryx-dim"> · {note}</span> : null}
        </span>
      </div>
    </footer>
  );
}
