import { useState } from "react";
import { wallet } from "../lib/wallet";

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await wallet.open(password);
      setPassword("");
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlock.");
    } finally {
      setBusy(false);
    }
  }

  // Centering is done by App's <main>.
  return (
    <form onSubmit={submit} className="panel w-full max-w-sm">
      <div className="mb-6 text-center">
        <p className="section-label">Locked</p>
        <h1 className="glow text-lg font-bold tracking-widest text-keryx-bright">
          WELCOME BACK
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-keryx-text">
          Enter your password to unlock your wallet.
        </p>
      </div>
      <label className="label">Password</label>
      <input
        type="password"
        autoFocus
        className="input mb-4"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="mb-4 text-sm text-keryx-error">{error}</p>}
      <button
        type="submit"
        className="btn-primary w-full"
        disabled={busy || password.length === 0}
      >
        {busy ? "Unlocking…" : "Unlock"}
      </button>
    </form>
  );
}
