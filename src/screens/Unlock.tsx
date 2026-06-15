import { useState } from "react";
import { wallet } from "../lib/wallet";
import logo from "../assets/keryx-logo.png";

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

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3">
          <img src={logo} alt="Keryx" className="h-14 w-14 rounded-2xl" />
          <h1 className="text-xl font-bold text-keryx-green">Welcome back</h1>
          <p className="text-sm text-emerald-100/60">
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
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          className="btn-primary w-full"
          disabled={busy || password.length === 0}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
