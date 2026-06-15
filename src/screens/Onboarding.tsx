import { useMemo, useState } from "react";
import { wallet } from "../lib/wallet";
import logo from "../assets/keryx-logo.png";

type Mode = "welcome" | "create" | "import" | "restore";

export function Onboarding({ onReady }: { onReady: () => void }) {
  const [mode, setMode] = useState<Mode>("welcome");

  if (mode === "create") return <CreateFlow onCancel={() => setMode("welcome")} onReady={onReady} />;
  if (mode === "import") return <ImportFlow onCancel={() => setMode("welcome")} onReady={onReady} />;
  if (mode === "restore") return <RestoreFileFlow onCancel={() => setMode("welcome")} onReady={onReady} />;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="panel w-full max-w-md text-center">
        <img src={logo} alt="Keryx" className="mx-auto mb-4 h-16 w-16 rounded-2xl" />
        <h1 className="text-2xl font-bold text-keryx-green">Keryx Wallet</h1>
        <p className="mt-2 text-sm text-emerald-100/60">
          A self-custodial wallet for the Keryx network. Your keys never leave
          this device.
        </p>
        <div className="mt-8 space-y-3">
          <button className="btn-primary w-full" onClick={() => setMode("create")}>
            Create a new wallet
          </button>
          <button className="btn-ghost w-full" onClick={() => setMode("import")}>
            Import recovery phrase
          </button>
          <button className="btn-ghost w-full" onClick={() => setMode("restore")}>
            Restore from wallet file
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Create ---

function CreateFlow({ onCancel, onReady }: { onCancel: () => void; onReady: () => void }) {
  const [step, setStep] = useState<"backup" | "confirm" | "password">("backup");
  const [phrase] = useState<string>(() => wallet.create());
  const [copied, setCopied] = useState(false);

  // Copying the seed is risky — it lingers on the OS clipboard where any app can read it.
  // We warn, and best-effort clear the clipboard after a short delay (audit A2).
  function copyPhrase() {
    navigator.clipboard
      ?.writeText(phrase)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          navigator.clipboard?.writeText("").catch(() => {});
          setCopied(false);
        }, 60_000);
      })
      .catch(() => {});
  }
  const words = useMemo(() => phrase.split(" "), [phrase]);

  // Pick two random word indexes for confirmation.
  const challenge = useMemo(() => {
    const idxs = new Set<number>();
    while (idxs.size < 2) idxs.add(Math.floor(Math.random() * words.length));
    return [...idxs].sort((a, b) => a - b);
  }, [words]);

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [confirmErr, setConfirmErr] = useState<string | null>(null);

  function checkConfirm() {
    const ok = challenge.every(
      (i) => (answers[i] ?? "").trim().toLowerCase() === words[i]
    );
    if (!ok) {
      setConfirmErr("Those words do not match. Check your backup.");
      return;
    }
    setConfirmErr(null);
    setStep("password");
  }

  if (step === "backup") {
    return (
      <Shell title="Back up your recovery phrase">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          Write these 24 words down in order and keep them offline. If you lose
          this phrase, <b>you lose your funds</b>. Never share it.
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {words.map((w, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-lg border border-keryx-border bg-black/30 px-2 py-1.5 text-sm"
            >
              <span className="text-emerald-200/40">{i + 1}.</span>
              <span className="font-mono text-keryx-green/90">{w}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-emerald-200/40">
            {copied
              ? "Copied — clipboard auto-clears in ~60s"
              : "Writing it down is safer than copying"}
          </span>
          <button className="btn-ghost" onClick={copyPhrase}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button className="btn-primary" onClick={() => setStep("confirm")}>
            I have written it down
          </button>
        </div>
        <CancelLink onCancel={onCancel} />
      </Shell>
    );
  }

  if (step === "confirm") {
    return (
      <Shell title="Confirm your backup">
        <p className="text-sm text-emerald-100/60">
          Enter the requested words to confirm you saved your phrase.
        </p>
        <div className="mt-4 space-y-3">
          {challenge.map((i) => (
            <div key={i}>
              <label className="label">Word #{i + 1}</label>
              <input
                className="input font-mono"
                value={answers[i] ?? ""}
                onChange={(e) =>
                  setAnswers((a) => ({ ...a, [i]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>
        {confirmErr && <p className="mt-3 text-sm text-red-400">{confirmErr}</p>}
        <div className="mt-5 flex justify-between">
          <button className="btn-ghost" onClick={() => setStep("backup")}>
            Back
          </button>
          <button className="btn-primary" onClick={checkConfirm}>
            Continue
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <PasswordStep
      onCancel={onCancel}
      onSubmit={async (pw) => {
        await wallet.finishCreate(pw, phrase);
        onReady();
      }}
    />
  );
}

// --- Import ---

function ImportFlow({ onCancel, onReady }: { onCancel: () => void; onReady: () => void }) {
  const [phrase, setPhrase] = useState("");
  const wordCount = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const validLen = wordCount === 12 || wordCount === 24;

  return (
    <PasswordStep
      onCancel={onCancel}
      title="Import recovery phrase"
      extra={
        <div className="mb-4">
          <label className="label">Recovery phrase (12 or 24 words)</label>
          <textarea
            className="input h-28 resize-none font-mono"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 …"
          />
          <p className="mt-1 text-xs text-emerald-200/40">
            {wordCount} word{wordCount === 1 ? "" : "s"}
            {wordCount > 0 && !validLen ? " — expected 12 or 24" : ""}
          </p>
        </div>
      }
      disabled={!validLen}
      onSubmit={async (pw) => {
        await wallet.importMnemonic(pw, phrase);
        onReady();
      }}
    />
  );
}

// --- Restore from exported wallet file ---

function RestoreFileFlow({ onCancel, onReady }: { onCancel: () => void; onReady: () => void }) {
  const [data, setData] = useState("");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setData(String(reader.result ?? "").trim());
    reader.readAsText(f);
  }

  const compact = data.trim().replace(/\s+/g, "");
  const looksValid = /^[0-9a-fA-F]+$/.test(compact) && compact.length >= 16;

  return (
    <PasswordStep
      onCancel={onCancel}
      title="Restore from wallet file"
      submitLabel="Restore wallet"
      extra={
        <div className="mb-4">
          <label className="label">Backup file (.txt) — or paste its contents</label>
          <input
            type="file"
            accept=".txt,.dat,text/plain"
            onChange={onFile}
            className="input mb-2 text-xs"
          />
          <textarea
            className="input h-24 resize-none break-all font-mono text-[10px]"
            value={data}
            onChange={(e) => setData(e.target.value)}
            placeholder="…encrypted wallet backup (hex)…"
          />
          <p className="mt-1 text-xs text-emerald-200/40">
            Enter the password the file was exported with. (Reveal-phrase is not
            available for a file restore — use phrase import if you need it.)
          </p>
        </div>
      }
      disabled={!looksValid}
      onSubmit={async (pw) => {
        await wallet.restoreFromFile(pw, data);
        onReady();
      }}
    />
  );
}

// --- shared password step ---

function PasswordStep({
  onCancel,
  onSubmit,
  title = "Set a password",
  extra,
  disabled,
  submitLabel = "Create wallet",
}: {
  onCancel: () => void;
  onSubmit: (pw: string) => Promise<void>;
  title?: string;
  extra?: React.ReactNode;
  disabled?: boolean;
  submitLabel?: string;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const canSubmit = pw.length >= 8 && pw === pw2 && !disabled && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Shell title={title}>
      <form onSubmit={submit}>
        {extra}
        <label className="label">Password (min. 8 characters)</label>
        <input
          type="password"
          className="input mb-1"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {tooShort && (
          <p className="mb-2 text-xs text-amber-300">Use at least 8 characters.</p>
        )}
        <label className="label mt-3">Confirm password</label>
        <input
          type="password"
          className="input"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
        {mismatch && (
          <p className="mt-2 text-xs text-red-400">Passwords do not match.</p>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-6 flex justify-between">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {busy ? "Working…" : submitLabel}
          </button>
        </div>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="panel w-full max-w-lg">
        <h1 className="mb-4 text-xl font-bold text-keryx-green">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function CancelLink({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="mt-4 text-center">
      <button
        className="text-xs text-emerald-200/40 hover:text-emerald-200/70"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
