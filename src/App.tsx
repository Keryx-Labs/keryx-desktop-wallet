import { useCallback, useEffect, useRef, useState } from "react";
import { wallet } from "./lib/wallet";
import { useWalletState } from "./lib/useWallet";
import { loadNodeSettings, saveNodeSettings } from "./lib/settings";
import { Onboarding } from "./screens/Onboarding";
import { Unlock } from "./screens/Unlock";
import { Home } from "./screens/Home";
import { Header } from "./components/Header";
import { NodeSettingsModal } from "./components/NodeSettingsModal";

type Phase = "loading" | "onboarding" | "unlock" | "home" | "error";

const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

export default function App() {
  const w = useWalletState();
  const [phase, setPhase] = useState<Phase>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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
    const reset = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void lock();
      }, AUTO_LOCK_MS);
    };
    const events = ["mousemove", "keydown", "click", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [phase, lock]);

  async function saveNode(s: { url: string; networkId: string }) {
    saveNodeSettings(s);
    const wasOpen = phase === "home";
    await wallet.setNode(s); // locks + resets if a wallet is open (network mismatch guard)
    setShowSettings(false);
    if (wasOpen) setPhase("unlock"); // changed node/network → re-unlock on the new network
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
            onSave={saveNode}
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
            onSave={saveNode}
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
      <Home />
      {showSettings && (
        <NodeSettingsModal
          initial={loadNodeSettings()}
          onSave={saveNode}
          onClose={() => setShowSettings(false)}
        />
      )}
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
      Node settings
    </button>
  );
}
