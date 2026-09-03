import { useState } from "react";
// keryx-mark.png is keryx-logo.png cropped to the glyph's bounding box: the master art is a
// 1024px square with ~93% transparent padding, so at nav size the untrimmed logo rendered as
// a 7px smudge. Re-cropped at 256px (it was 128px), which is what the 24px box actually needs
// on a 2x display. keryx-logo.png stays the source of truth for the art.
import mark from "../assets/keryx-mark.png";
import { ConnStatus, formatKrxShort } from "../lib/wallet";
import { ModalKey } from "../lib/nav";

/**
 * Sticky translucent bar, matching the nav on keryx-labs.com (same blur, same hairline).
 *
 * WHAT THIS BAR IS FOR: identity and state — which wallet, how many there are, what they
 * hold in total, and whether the node is reachable. It deliberately carries NO actions
 * beyond Settings and Lock.
 *
 * It used to also carry a Send/Receive/Consolidate/Addresses nav copied from the website.
 * That was a duplicate of the buttons in the balance card, and the weaker of the two
 * copies: the card's buttons are large, disable themselves with a reason when the node is
 * not ready, and sit next to the number they act on. A website needs the nav because it
 * has pages; this app has one screen and a set of overlays, so the row was decoration that
 * doubled every action. The nav is gone; the card's buttons are the way in.
 */
export function Header({
  conn,
  synced,
  walletLabel,
  walletCount,
  totalSompi,
  onOpen,
  onLock,
}: {
  conn?: ConnStatus;
  synced?: boolean;
  /** Alias of the active wallet. Absent pre-unlock, when there is no wallet to name. */
  walletLabel?: string | null;
  /** How many wallets the file holds, shown inside the selector. */
  walletCount?: number;
  /** Mature total across every wallet. */
  totalSompi?: bigint;
  onOpen: (key: ModalKey) => void;
  onLock?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Pre-unlock there is no wallet to act on, so the bar is just identity + Settings.
  const unlocked = conn !== undefined;

  return (
    <header
      className="sticky top-0 z-40 border-b border-keryx-border"
      style={{
        background: "rgba(7, 10, 8, 0.82)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <div className="mx-auto flex w-full max-w-content items-center gap-4 px-4 py-2 lg:px-6">
        {/* Top-left is the first thing read and the OS title bar directly above it already
            says "Keryx Wallet" with this same mark — repeating the wordmark here spent the
            most valuable slot in the window on an answer the user already had. It names the
            ACTIVE WALLET instead, which is the question multi-wallet actually raises, and
            it is the way into the manager. The wordmark returns pre-unlock, where there is
            no wallet to name. */}
        {walletLabel ? (
          <WalletSelector
            label={walletLabel}
            count={walletCount ?? 1}
            totalSompi={totalSompi}
            onOpen={() => onOpen("addresses")}
          />
        ) : (
          <div className="flex shrink-0 items-center gap-2.5">
            <img src={mark} alt="" className="h-6 w-6" />
            <span className="glow text-[13px] font-bold tracking-widest text-keryx-bright">
              KERYX<span className="ml-1.5 text-keryx-dim">WALLET</span>
            </span>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {unlocked && <ConnectionBadge conn={conn} synced={synced === true} />}
          <button
            onClick={() => onOpen("settings")}
            className="btn-ghost hidden px-3 py-1.5 text-[11px] md:inline-flex"
          >
            Settings
          </button>
          {onLock && (
            <button onClick={onLock} className="btn-ghost hidden px-3 py-1.5 text-[11px] md:inline-flex">
              Lock
            </button>
          )}
          {/* The window can be as narrow as 420px; below md Settings and Lock collapse here. */}
          <button
            className="flex flex-col justify-center gap-1.5 p-1 md:hidden"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="block h-px w-5 bg-keryx-mid" />
            <span className="block h-px w-5 bg-keryx-mid" />
            <span className="block h-px w-5 bg-keryx-mid" />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="flex flex-col border-t border-keryx-border px-4 py-2 text-[13px] md:hidden">
          <button
            onClick={() => {
              setMenuOpen(false);
              onOpen("settings");
            }}
            className="py-2 text-left text-keryx-dim transition-colors hover:text-keryx-bright"
          >
            Settings
          </button>
          {onLock && (
            <button
              onClick={() => {
                setMenuOpen(false);
                onLock();
              }}
              className="py-2 text-left text-keryx-dim transition-colors hover:text-keryx-bright"
            >
              Lock
            </button>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * The active wallet, as a control rather than a caption.
 *
 * Bare text with a small caret read as a label nobody would think to click, so this is
 * bordered and hover-lit like every other control in the app — a thing you press. It
 * states the count, because "which of how many" is the whole question multi-wallet raises,
 * and carries the all-wallets total, which used to sit in the balance card repeating the
 * same relationship one card lower.
 *
 * The total is the second line rather than a third column so that it survives the 420px
 * window instead of being hidden by a breakpoint — it is the only place on the main screen
 * that shows it.
 */
function WalletSelector({
  label,
  count,
  totalSompi,
  onOpen,
}: {
  label: string;
  count: number;
  totalSompi?: bigint;
  onOpen: () => void;
}) {
  const many = count > 1;
  return (
    <button
      onClick={onOpen}
      aria-haspopup="dialog"
      title={
        many
          ? `Switch between your ${count} wallets, rename, add or remove them`
          : "Manage your wallets — rename, add or import another"
      }
      className="group flex min-w-0 shrink items-center gap-2.5 rounded-sm border border-keryx-border bg-keryx-green/[.03] px-2.5 py-1 text-left transition-colors hover:border-keryx-green"
    >
      <img src={mark} alt="" className="h-6 w-6 shrink-0" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="glow truncate text-[13px] font-bold tracking-widest text-keryx-bright">
            {label}
          </span>
          {/* An SVG, not a "▾": JetBrains Mono has no glyph for the geometric triangles, so
              the fallback font rendered it as a 3px dot that read as punctuation after the
              name — the opposite of the "this opens something" signal it was there to give. */}
          <svg
            viewBox="0 0 10 6"
            className="h-[5px] w-[9px] shrink-0 text-keryx-dim transition-colors group-hover:text-keryx-green"
            aria-hidden
          >
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
          </svg>
          {/* The count belongs INSIDE the control, so "2 wallets" reads as "this is one of two"
              rather than as a stray number elsewhere on the screen. */}
          <span className="shrink-0 whitespace-nowrap rounded-full border border-keryx-border px-1.5 text-[9px] uppercase leading-[15px] tracking-label text-keryx-mid transition-colors group-hover:border-keryx-green/40">
            <span className="num">{count}</span> {count === 1 ? "wallet" : "wallets"}
          </span>
        </span>
        <span className="num mt-px block truncate text-[9px] text-keryx-dim">
          {totalSompi !== undefined
            ? `${formatKrxShort(totalSompi)} KRX ${many ? "all wallets" : "total"}`
            : ""}
        </span>
      </span>
    </button>
  );
}

export function ConnectionBadge({
  conn,
  synced,
}: {
  conn: ConnStatus;
  synced: boolean;
}) {
  const map: Record<ConnStatus, { label: string; dot: string }> = {
    connected: {
      label: synced ? "SYNCED" : "SYNCING",
      dot: synced ? "bg-keryx-green" : "bg-keryx-warn",
    },
    connecting: { label: "CONNECTING", dot: "bg-keryx-warn animate-pulse" },
    disconnected: { label: "OFFLINE", dot: "bg-keryx-error" },
  };
  const s = map[conn];
  return (
    <span className="badge text-[10px] uppercase tracking-label">
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
