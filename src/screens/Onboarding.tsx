import { useMemo, useState } from "react";
import { wallet } from "../lib/wallet";
import { SeedBackup } from "../components/SeedBackup";
import { AliasField } from "../components/AliasField";

type Mode = "welcome" | "create" | "import" | "restore";

export function Onboarding({ onReady }: { onReady: () => void }) {
  const [mode, setMode] = useState<Mode>("welcome");

  if (mode === "create") return <CreateFlow onCancel={() => setMode("welcome")} onReady={onReady} />;
  if (mode === "import") return <ImportFlow onCancel={() => setMode("welcome")} onReady={onReady} />;
  if (mode === "restore") return <RestoreFileFlow onCancel={() => setMode("welcome")} onReady={onReady} />;

  return (
    <div className="panel w-full max-w-md text-center">
      <p className="section-label">Welcome</p>
      <h1 className="glow text-xl font-bold tracking-widest text-keryx-bright">
        KERYX WALLET
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-keryx-text">
        A self-custodial wallet for the Keryx network. Your keys never leave this device.
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
  );
}

// --- Create ---

function CreateFlow({ onCancel, onReady }: { onCancel: () => void; onReady: () => void }) {
  const [step, setStep] = useState<"backup" | "password">("backup");
  const [phrase] = useState<string>(() => wallet.create());
  const words = useMemo(() => phrase.split(" "), [phrase]);
  const [alias, setAlias] = useState("");

  if (step === "backup") {
    return (
      <Shell title="Back up your recovery phrase">
        <SeedBackup
          words={words}
          onConfirmed={() => setStep("password")}
          onCancel={onCancel}
        />
      </Shell>
    );
  }

  return (
    <PasswordStep
      onCancel={onCancel}
      extra={<AliasField value={alias} onChange={setAlias} />}
      onSubmit={async (pw) => {
        await wallet.finishCreate(pw, phrase, alias);
        onReady();
      }}
    />
  );
}

// --- Import ---

function ImportFlow({ onCancel, onReady }: { onCancel: () => void; onReady: () => void }) {
  const [phrase, setPhrase] = useState("");
  const [alias, setAlias] = useState("");
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
            className="input h-28 resize-none"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 …"
          />
          <p className="mt-1 text-xs text-keryx-dim">
            {wordCount} word{wordCount === 1 ? "" : "s"}
            {wordCount > 0 && !validLen ? " (expected 12 or 24)" : ""}
          </p>
          <AliasField value={alias} onChange={setAlias} />
        </div>
      }
      disabled={!validLen}
      onSubmit={async (pw) => {
        await wallet.importMnemonic(pw, phrase, alias);
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
          <label className="label">Backup file (.txt), or paste its contents</label>
          <input
            type="file"
            accept=".txt,.dat,text/plain"
            onChange={onFile}
            className="input mb-2 text-xs"
          />
          <textarea
            className="input h-24 resize-none break-all text-[10px]"
            value={data}
            onChange={(e) => setData(e.target.value)}
            placeholder="…encrypted wallet backup (hex)…"
          />
          <p className="mt-1 text-xs leading-relaxed text-keryx-dim">
            Enter the password the file was exported with. (Reveal-phrase is not
            available for a file restore; use phrase import if you need it.)
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
          <p className="mb-2 text-xs text-keryx-warn">Use at least 8 characters.</p>
        )}
        <label className="label mt-3">Confirm password</label>
        <input
          type="password"
          className="input"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
        {mismatch && (
          <p className="mt-2 text-xs text-keryx-error">Passwords do not match.</p>
        )}
        {error && <p className="mt-3 text-sm text-keryx-error">{error}</p>}
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

/** Centering is done by App's <main>; this is just the panel and its heading. */
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel w-full max-w-lg">
      <h1 className="section-label mb-4">{title}</h1>
      {children}
    </div>
  );
}
