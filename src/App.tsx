import { useCallback, useEffect, useRef, useState } from "react";
import { wallet } from "./lib/wallet";
import { useWalletState } from "./lib/useWallet";
import {
  loadAutoLockMinutes,
  loadNodeSettings,
  saveAutoLockMinutes,
  saveNodeSettings,
} from "./lib/settings";
import { ModalKey } from "./lib/nav";
import { Onboarding } from "./screens/Onboarding";
import { Unlock } from "./screens/Unlock";
import { Home } from "./screens/Home";
import { Send } from "./screens/Send";
import { Receive } from "./screens/Receive";
import { Consolidate } from "./screens/Consolidate";
import { Addresses } from "./screens/Addresses";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { ProgressBar, consolidateRunPercent } from "./components/ProgressBar";
import { NodeSettingsModal } from "./components/NodeSettingsModal";

type Phase = "loading" | "onboarding" | "unlock" | "home" | "error";

export default function App() {
  const w = useWalletState();
  const [phase, setPhase] = useState<Phase>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  // Which overlay is open. Lives here rather than in Home so the header nav and Home's
  // own buttons open the same thing.
  const [modal, setModal] = useState<ModalKey | null>(null);
  const [autoLockMinutes, setAutoLockMinutes] = useState(loadAutoLockMinutes);

  const closeModal = useCallback(() => setModal(null), []);

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
    setModal(null);
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
    setModal(null);
    // Only reconnect (which locks the wallet) when the node actually changed — saving just the
    // auto-lock timeout must not log the user out.
    if (nodeChanged) {
      const wasOpen = phase === "home";
      await wallet.setNode(s); // locks + resets if a wallet is open (network mismatch guard)
      if (wasOpen) setPhase("unlock"); // changed node/network → re-unlock on the new network
    }
  }

  const settingsModal =
    modal === "settings" ? (
      <NodeSettingsModal
        initial={loadNodeSettings()}
        initialAutoLockMinutes={autoLockMinutes}
        onSave={saveSettings}
        onClose={closeModal}
      />
    ) : null;

  if (phase === "loading") {
    return (
      <Shell>
        <Center>
          <p className="animate-pulse text-xs uppercase tracking-label text-keryx-dim">
            Loading Keryx…
          </p>
        </Center>
      </Shell>
    );
  }

  if (phase === "error") {
    return (
      <Shell>
        <Center>
          <div className="panel max-w-sm text-center">
            <h1 className="mb-2 text-sm font-bold uppercase tracking-label text-keryx-error">
              Initialization failed
            </h1>
            <p className="text-sm leading-relaxed text-keryx-text">{bootError}</p>
          </div>
        </Center>
      </Shell>
    );
  }

  // Onboarding and Unlock share a slim shell: logo, Settings (the node has to be
  // reachable before either can do anything) and the footer. This replaces the floating
  // Settings button that used to sit in the corner of those two screens only.
  if (phase === "onboarding" || phase === "unlock") {
    return (
      <Shell>
        <Header onOpen={setModal} />
        <main className="flex flex-1 items-center justify-center px-4 py-8">
          {phase === "onboarding" ? (
            <Onboarding onReady={() => setPhase("home")} />
          ) : (
            <Unlock onUnlocked={() => setPhase("home")} />
          )}
        </main>
        <Footer note={`v${__APP_VERSION__}`} />
        {settingsModal}
      </Shell>
    );
  }

  // home
  return (
    <Shell>
      <Header
        conn={w.conn}
        synced={w.synced}
        walletLabel={w.activeWallet?.alias ?? null}
        walletCount={w.walletCount}
        totalSompi={w.totalBalanceSompi}
        onOpen={setModal}
        onLock={lock}
      />
      <main className="mx-auto flex w-full max-w-content flex-1 flex-col px-4 py-6 lg:px-6">
        <ConsolidateStrip />
        <Home onOpen={setModal} />
      </main>
      <Footer note={`v${__APP_VERSION__} · ${w.networkId}`} />

      {modal === "send" && <Send onClose={closeModal} />}
      {modal === "receive" && <Receive onClose={closeModal} />}
      {modal === "consolidate" && <Consolidate onClose={closeModal} />}
      {modal === "addresses" && <Addresses onClose={closeModal} />}
      {settingsModal}
    </Shell>
  );
}

/** Column layout that keeps the footer pinned to the bottom of the window. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col">{children}</div>;
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
    <div className="card mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[11px]">
        <span className="flex items-center gap-2 text-keryx-green">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-keryx-green" />
          Consolidating · round {run.round}/{run.round + run.roundsEstimate - 1} ·{" "}
          {run.txsSubmitted} tx{run.txsSubmitted === 1 ? "" : "s"}
        </span>
        <span className="num text-keryx-dim">
          {run.startCount} → {run.remaining} UTXOs
        </span>
      </div>
      <ProgressBar percent={consolidateRunPercent(run)} />
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-4">{children}</div>;
}
