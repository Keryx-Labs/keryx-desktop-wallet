import { DEFAULT_NODE, NodeSettings } from "./wallet";

const KEY = "keryx.node";

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
