import logo from "../assets/keryx-logo.png";
import { ConnStatus } from "../lib/wallet";

export function Header({
  conn,
  synced,
  onSettings,
  onLock,
}: {
  conn: ConnStatus;
  synced: boolean;
  onSettings?: () => void;
  onLock?: () => void;
}) {
  return (
    <header className="flex items-center justify-between border-b border-keryx-border px-5 py-3">
      <div className="flex items-center gap-2.5">
        <img src={logo} alt="Keryx" className="h-8 w-8 rounded-lg" />
        <span className="text-lg font-bold tracking-tight text-keryx-green">
          Keryx
        </span>
      </div>
      <div className="flex items-center gap-3">
        <ConnectionBadge conn={conn} synced={synced} />
        {onSettings && (
          <button onClick={onSettings} className="btn-ghost px-3 py-1.5 text-xs">
            Settings
          </button>
        )}
        {onLock && (
          <button onClick={onLock} className="btn-ghost px-3 py-1.5 text-xs">
            Lock
          </button>
        )}
      </div>
    </header>
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
      label: synced ? "Connected · Synced" : "Connected · Syncing…",
      dot: synced ? "bg-keryx-green" : "bg-amber-400",
    },
    connecting: { label: "Connecting…", dot: "bg-amber-400 animate-pulse" },
    disconnected: { label: "Disconnected", dot: "bg-red-500" },
  };
  const s = map[conn];
  return (
    <span className="flex items-center gap-2 rounded-full border border-keryx-border px-3 py-1 text-xs text-emerald-100/80">
      <span className={`h-2 w-2 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
