import { useCallback, useEffect, useRef, useState } from "react";
import { wallet } from "./lib/wallet";
import { useWalletState } from "./lib/useWallet";
import {
  loadAutoLockMinutes,
  loadNodeSettings,
  saveAutoLockMinutes,
  saveNodeSettings,
} from "./lib/settings";
import { Onboarding } from "./screens/Onboarding";
import { Unlock } from "./screens/Unlock";
import { Home } from "./screens/Home";
import { Header } from "./components/Header";
import { NodeSettingsModal } from "./components/NodeSettingsModal";

type Phase = "loading" | "onboarding" | "unlock" | "home" | "error";

export default function App() {
  const w = useWalletState();
  const [phase, setPhase] = useState<Phase>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState(loadAutoLockMinutes);

  // --- boot: load wasm + node settings, decide onboarding vs unlock ---
  useEffect(() => {
    (async () => {
      try {
        await wallet.init();
        await wallet.setNode(loadNodeSettings());
        const exists = await wallet.exists();
        setPhase(exists ? "unlock" : "onboarding");
      } catch (e) {
        setBootError(e instanceof Error ? e.message : "Failed to initialize.");
        setPhase("error");
      }
    })();
  }, []);

  const lock = useCallback(async () => {
    await wallet.lock();
    setPhase("unlock");
  }, []);

  // --- auto-lock on inactivity (only while unlocked) ---
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== "home") return;
    if (autoLockMinutes <= 0) return;
    // A consolidation of a large wallet runs for several minutes with no mouse or keyboard activity.
    // Auto-locking through it would kill the run mid-flight, so hold off while one is in progress —
    // the timer re-arms as soon as it finishes.
    if (w.isConsolidating) return;
    const reset = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void lock();
      }, autoLockMinutes * 60 * 1000);
    };
    const events = ["mousemove", "keydown", "click", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [phase, lock, autoLockMinutes, w.isConsolidating]);

  async function saveSettings(s: { url: string; networkId: string }, nextAutoLockMinutes: number) {
    const prev = loadNodeSettings();
    const nodeChanged = s.url !== prev.url || s.networkId !== prev.networkId;
    saveNodeSettings(s);
    saveAutoLockMinutes(nextAutoLockMinutes);
    setAutoLockMinutes(nextAutoLockMinutes);
    setShowSettings(false);
    // Only reconnect (which locks the wallet) when the node actually changed — saving just the
    // auto-lock timeout must not log the user out.
    if (nodeChanged) {
      const wasOpen = phase === "home";
      await wallet.setNode(s); // locks + resets if a wallet is open (network mismatch guard)
      if (wasOpen) setPhase("unlock"); // changed node/network → re-unlock on the new network
    }
  }

  if (phase === "loading") {
    return (
      <Center>
        <p className="animate-pulse text-keryx-green">Loading Keryx…</p>
      </Center>
    );
  }

  if (phase === "error") {
    return (
      <Center>
        <div className="panel max-w-sm text-center">
          <h1 className="mb-2 text-lg font-bold text-red-400">
            Initialization failed
          </h1>
          <p className="text-sm text-emerald-100/60">{bootError}</p>
        </div>
      </Center>
    );
  }

  if (phase === "onboarding") {
    return (
      <>
        <Onboarding onReady={() => setPhase("home")} />
        <SettingsButtonFloating onClick={() => setShowSettings(true)} />
        {showSettings && (
          <NodeSettingsModal
            initial={loadNodeSettings()}
            initialAutoLockMinutes={autoLockMinutes}
            onSave={saveSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
      </>
    );
  }

  if (phase === "unlock") {
    return (
      <>
        <Unlock onUnlocked={() => setPhase("home")} />
        <SettingsButtonFloating onClick={() => setShowSettings(true)} />
        {showSettings && (
          <NodeSettingsModal
            initial={loadNodeSettings()}
            initialAutoLockMinutes={autoLockMinutes}
            onSave={saveSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
      </>
    );
  }

  // home
  return (
    <div className="min-h-screen">
      <Header
        conn={w.conn}
        synced={w.synced}
        onSettings={() => setShowSettings(true)}
        onLock={lock}
      />
      <ConsolidateStrip />
      <Home />
      {showSettings && (
        <NodeSettingsModal
          initial={loadNodeSettings()}
          initialAutoLockMinutes={autoLockMinutes}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/**
 * Persistent strip shown while a consolidation runs, so a background run is never invisible — the
 * whole point of moving the run onto the service. Reads the same observable state the modal does.
 */
function ConsolidateStrip() {
  const w = useWalletState();
  const run = w.consolidateRun;
  if (!run?.running) return null;
  return (
    <div className="mx-auto mt-4 flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-keryx-green/40 bg-keryx-green/10 px-4 py-2 text-xs">
      <span className="flex items-center gap-2 text-keryx-green">
        <span className="h-2 w-2 animate-pulse rounded-full bg-keryx-green" />
        Consolidating · round {run.round}/{run.round + run.roundsEstimate - 1} ·{" "}
        {run.txsSubmitted} tx{run.txsSubmitted === 1 ? "" : "s"}
      </span>
      <span className="font-mono text-emerald-200/60">
        {run.startCount} → {run.remaining} UTXOs
      </span>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      {children}
    </div>
  );
}

function SettingsButtonFloating({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-ghost fixed bottom-4 right-4 px-3 py-1.5 text-xs"
    >
      Settings
    </button>
  );
}
