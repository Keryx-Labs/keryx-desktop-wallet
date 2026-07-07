import { DEFAULT_NODE, NodeSettings } from "./wallet";

const KEY = "keryx.node";
const AUTO_LOCK_KEY = "keryx.autoLockMinutes";

export const DEFAULT_AUTO_LOCK_MINUTES = 5;

export function loadNodeSettings(): NodeSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_NODE };
    const parsed = JSON.parse(raw) as Partial<NodeSettings>;
    return {
      url: parsed.url || DEFAULT_NODE.url,
      networkId: parsed.networkId || DEFAULT_NODE.networkId,
    };
  } catch {
    return { ...DEFAULT_NODE };
  }
}

export function saveNodeSettings(s: NodeSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function loadAutoLockMinutes(): number {
  const raw = localStorage.getItem(AUTO_LOCK_KEY);
  if (raw === null) return DEFAULT_AUTO_LOCK_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.max(0, Math.min(1440, Math.floor(minutes)));
}

export function saveAutoLockMinutes(minutes: number) {
  localStorage.setItem(
    AUTO_LOCK_KEY,
    String(Math.max(0, Math.min(1440, Math.floor(minutes))))
  );
}
