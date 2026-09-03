import { useMemo, useState } from "react";
import {
  PHRASE_FILENAME,
  parsePhraseFile,
  phraseBody,
  phraseFileText,
} from "../lib/phrase";

/**
 * Show a fresh recovery phrase, let the user save it, and prove they did before moving on.
 *
 * Shared by onboarding (the first wallet) and the wallet manager (every wallet added after it):
 * a wallet that will hold funds must never be created without its phrase backed up, and having
 * one implementation means the two paths cannot drift apart on something this consequential.
 */
export function SeedBackup({
  words,
  onConfirmed,
  onCancel,
  cancelLabel = "Cancel",
}: {
  words: string[];
  onConfirmed: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const [step, setStep] = useState<"backup" | "confirm">("backup");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Copying the seed is risky — it lingers on the OS clipboard where any app can read it.
  // We warn, and best-effort clear the clipboard after a short delay (audit A2).
  function copyPhrase() {
    navigator.clipboard
      ?.writeText(phraseBody(words).join("\n"))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          navigator.clipboard?.writeText("").catch(() => {});
          setCopied(false);
        }, 60_000);
      })
      .catch(() => {});
  }

  // Saving the phrase in the clear is a real risk: the file lands in the downloads folder where
  // any process running as this user can read it. We offer it anyway because mis-transcribing 24
  // words is how backups actually get lost — and warn instead of hiding it. The confirm step can
  // read this file back to check the transcription.
  function downloadPhrase() {
    try {
      const blob = new Blob([phraseFileText(words)], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = PHRASE_FILENAME;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaved(true);
      setSaveErr(null);
    } catch {
      setSaveErr("Could not save the file. Write the words down instead.");
    }
  }

  // Pick two random word indexes for confirmation.
  //
  // Keyed on the joined phrase, NOT on the `words` array: callers build that array with
  // phrase.split(" "), so its identity changes on every render, and the wallet service emits on
  // every balance poll. Depending on the array re-rolled the challenge underneath the user while
  // they were typing — the two words asked for would silently change and their answers stop
  // matching. A primitive key makes it stable for the life of the phrase.
  const phraseKey = words.join(" ");
  const challenge = useMemo(() => {
    const idxs = new Set<number>();
    while (idxs.size < 2) idxs.add(Math.floor(Math.random() * words.length));
    return [...idxs].sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phraseKey]);

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);

  /** Verify the whole phrase against a saved file — a stricter check than the two words. */
  function verifyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // so the same file can be picked again after an error
    if (!f) return;
    const reader = new FileReader();
    reader.onerror = () => setFileErr("Could not read that file.");
    reader.onload = () => {
      const got = parsePhraseFile(String(reader.result ?? ""));
      if (got.length !== words.length) {
        setFileErr(
          `That file has ${got.length} word${got.length === 1 ? "" : "s"}, not ${words.length}.`
        );
        return;
      }
      if (got.join(" ") !== words.join(" ")) {
        setFileErr("That file does not match this phrase. Pick the one you just saved.");
        return;
      }
      setFileErr(null);
      onConfirmed();
    };
    reader.readAsText(f);
  }

  function checkConfirm() {
    const ok = challenge.every(
      (i) => (answers[i] ?? "").trim().toLowerCase() === words[i]
    );
    if (!ok) {
      setConfirmErr("Those words do not match. Check your backup.");
      return;
    }
    setConfirmErr(null);
    onConfirmed();
  }

  if (step === "backup") {
    return (
      <>
        <div className="rounded-sm border border-keryx-warn/40 bg-keryx-warn/10 p-3 text-sm leading-relaxed text-keryx-warn">
          Write these {words.length} words down in order and keep them offline. If you
          lose this phrase, <b>you lose the funds in this wallet</b>. Never share it.
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {words.map((w, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-sm border border-keryx-border bg-keryx-green/[0.03] px-2 py-1.5 text-sm"
            >
              <span className="num text-keryx-dim">{i + 1}.</span>
              <span className="text-keryx-ink">{w}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-keryx-dim">
          Paper is the safest option. The clipboard and a{" "}
          <code className="code-inline">.txt</code> file can both be read by anything else
          running on this computer.
        </p>
        {copied && (
          <p className="mt-1 text-xs text-keryx-mid">
            Copied the phrase plus a numbered list — clipboard auto-clears in ~60s.
          </p>
        )}
        {saved && (
          <p className="mt-1 text-xs text-keryx-mid">
            Saved “{PHRASE_FILENAME}” to your downloads. Move it somewhere safe.
          </p>
        )}
        {saveErr && <p className="mt-1 text-xs text-keryx-error">{saveErr}</p>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="btn-ghost" onClick={copyPhrase}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button className="btn-ghost" onClick={downloadPhrase}>
            {saved ? "Saved ✓" : "Download .txt"}
          </button>
        </div>
        <button className="btn-primary mt-2 w-full" onClick={() => setStep("confirm")}>
          I have written it down
        </button>
        <div className="mt-4 text-center">
          <button
            className="text-[10px] uppercase tracking-label text-keryx-dim hover:text-keryx-mid"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="text-sm leading-relaxed text-keryx-text">
        Enter the requested words to confirm you saved your phrase.
      </p>
      <div className="mt-4 space-y-3">
        {challenge.map((i) => (
          <div key={i}>
            <label className="label">Word #{i + 1}</label>
            <input
              className="input"
              value={answers[i] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      {confirmErr && <p className="mt-3 text-sm text-keryx-error">{confirmErr}</p>}
      <div className="mt-6 border-t border-keryx-border pt-4">
        <p className="section-label">Or verify with your backup file</p>
        <p className="mb-2 text-xs leading-relaxed text-keryx-dim">
          Pick the <code className="code-inline">.txt</code> you saved. All {words.length}{" "}
          words must match — it is read here on this device and never leaves it.
        </p>
        <input
          type="file"
          accept=".txt,text/plain"
          onChange={verifyFile}
          className="input text-xs"
        />
        {fileErr && <p className="mt-2 text-sm text-keryx-error">{fileErr}</p>}
      </div>
      <div className="mt-5 flex justify-between">
        <button className="btn-ghost" onClick={() => setStep("backup")}>
          Back
        </button>
        <button className="btn-primary" onClick={checkConfirm}>
          Continue
        </button>
      </div>
    </>
  );
}
