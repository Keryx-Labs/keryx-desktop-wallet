import { useState } from "react";
import { NodeSettings, wallet } from "../lib/wallet";

const DEFAULT_PORT = "23110"; // Keryx Borsh wRPC default

// Plaintext ws:// is only safe to a loopback host; a remote node must use wss://.
// The CSP enforces the same rule (connect-src allows ws: only for loopback), so a
// remote ws:// would silently fail to connect — we block it here with a clear message.
function isLoopbackHost(h: string): boolean {
  const host = h.trim().toLowerCase();
  // Keep this in lockstep with the CSP connect-src (loopback = plaintext ws OK).
  // IPv6 loopback isn't listed: use "localhost", which the CSP allows by name.
  return host === "127.0.0.1" || host === "localhost";
}

// Split a stored "ws://host:port" URL back into its parts for the editable fields.
function splitUrl(u: string): { secure: boolean; host: string; port: string } {
  const secure = /^wss:\/\//i.test(u);
  const rest = u.replace(/^wss?:\/\//i, "");
  const [host, port] = rest.split(":");
  return { secure, host: host || "127.0.0.1", port: port || DEFAULT_PORT };
}

export function NodeSettingsModal({
  initial,
  initialAutoLockMinutes,
  onSave,
  onClose,
}: {
  initial: NodeSettings;
  initialAutoLockMinutes: number;
  onSave: (s: NodeSettings, autoLockMinutes: number) => void;
  onClose: () => void;
}) {
  const init0 = splitUrl(initial.url);
  const [host, setHost] = useState(init0.host);
  const [port, setPort] = useState(init0.port);
  const [secure, setSecure] = useState(init0.secure);
  const [networkId, setNetworkId] = useState(initial.networkId);
  const [autoLockMinutes, setAutoLockMinutes] = useState(String(initialAutoLockMinutes));
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const cleanHost = host.trim();
  const cleanPort = (port.trim() || DEFAULT_PORT).replace(/[^0-9]/g, "");
  const builtUrl = `${secure ? "wss" : "ws"}://${cleanHost}:${cleanPort}`;
  const previewUrl = `${secure ? "wss" : "ws"}://${cleanHost || "…"}:${cleanPort}`;
  const loopback = isLoopbackHost(cleanHost);
  const insecureRemote = !secure && cleanHost.length > 0 && !loopback;
  const valid = cleanHost.length > 0 && cleanPort.length > 0 && !insecureRemote;
  const cleanAutoLockMinutes = Math.max(
    0,
    Math.min(1440, Math.floor(Number(autoLockMinutes) || 0))
  );

  async function testConnection() {
    setTestMsg(null);
    setTesting(true);
    try {
      const r = await wallet.testConnection(builtUrl, networkId);
      if (r.ok) {
        const netWarn =
          r.networkId && r.networkId !== networkId
            ? ` ⚠ node network is ${r.networkId}`
            : "";
        setTestMsg({
          ok: true,
          text:
            `Connected · ${r.synced ? "synced" : "NOT synced"} · ` +
            `utxoindex ${r.utxoIndex ? "on" : "OFF ⚠"} · v${r.version ?? "?"} · ` +
            `DAA ${r.daaScore ?? "?"}${netWarn}`,
        });
      } else {
        setTestMsg({ ok: false, text: r.error ?? "Could not reach the node." });
      }
    } catch (e) {
      setTestMsg({
        ok: false,
        text: e instanceof Error ? e.message : "Test failed.",
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel max-h-[90vh] w-full max-w-md overflow-y-auto">
        <h2 className="mb-4 text-lg font-bold text-keryx-green">Settings</h2>

        <label className="label">Node IP / host</label>
        <input
          className="input mb-3 font-mono"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="127.0.0.1  ·  node.example.com"
        />
        <label className="label">Port</label>
        <input
          className="input mb-3 font-mono"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          inputMode="numeric"
          placeholder={DEFAULT_PORT}
        />
        <label className="mb-3 flex items-center gap-2 text-sm text-emerald-100/70">
          <input
            type="checkbox"
            checked={secure}
            onChange={(e) => setSecure(e.target.checked)}
          />
          Secure (wss) — only if your node has TLS
        </label>
        {insecureRemote && (
          <p className="mb-3 text-xs text-amber-300">
            Remote nodes require a secure connection. Enable “Secure (wss)”, or run
            a local node at 127.0.0.1 (e.g. via an SSH tunnel).
          </p>
        )}
        <p className="mb-3 text-xs text-emerald-200/40">
          Connects to <span className="font-mono text-keryx-green/70">{previewUrl}</span>.
          The node must run with <span className="font-mono">--utxoindex</span>.
        </p>

        <button
          className="btn-ghost mb-2 w-full"
          onClick={testConnection}
          disabled={!valid || testing}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        {testMsg && (
          <p
            className={`mb-4 break-words text-xs ${
              testMsg.ok ? "text-keryx-green/80" : "text-red-400"
            }`}
          >
            {testMsg.ok ? "✓ " : "✗ "}
            {testMsg.text}
          </p>
        )}

        <label className="label">Network</label>
        <select
          className="input mb-4"
          value={networkId}
          onChange={(e) => setNetworkId(e.target.value)}
        >
          <option value="mainnet">mainnet</option>
          <option value="testnet-11">testnet-11</option>
          <option value="simnet">simnet</option>
        </select>

        <label className="label">Auto-lock timeout</label>
        <select
          className="input mb-4"
          value={autoLockMinutes}
          onChange={(e) => setAutoLockMinutes(e.target.value)}
        >
          <option value="1">1 minute</option>
          <option value="5">5 minutes</option>
          <option value="15">15 minutes</option>
          <option value="30">30 minutes</option>
          <option value="60">1 hour</option>
          <option value="240">4 hours</option>
          <option value="0">Never</option>
        </select>
        <div className="mb-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn-primary"
            disabled={!valid}
            onClick={() =>
              onSave({
                url: `${secure ? "wss" : "ws"}://${cleanHost}:${cleanPort}`,
                networkId,
              }, cleanAutoLockMinutes)
            }
          >
            Save settings
          </button>
        </div>

        {wallet.hasSeedBackup() && <RevealPhraseSection />}
        {wallet.isOpen && <ChangePasswordSection />}
        {wallet.isOpen && <ExportWalletSection />}
      </div>
    </div>
  );
}

function ChangePasswordSection() {
  const [open, setOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset() {
    setOpen(false);
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setErr(null);
    setDone(false);
    setBusy(false);
  }

  async function submit() {
    setErr(null);
    if (newPw.length < 8) {
      setErr("New password must be at least 8 characters.");
      return;
    }
    if (newPw !== confirmPw) {
      setErr("New passwords do not match.");
      return;
    }
    if (newPw === oldPw) {
      setErr("New password must be different.");
      return;
    }
    setBusy(true);
    try {
      await wallet.changePassword(oldPw, newPw);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-keryx-border pt-4">
      <h3 className="mb-1 text-sm font-semibold text-keryx-green">
        Change password
      </h3>
      {!open && (
        <button className="btn-ghost w-full" onClick={() => setOpen(true)}>
          Change password
        </button>
      )}
      {open && !done && (
        <>
          <input
            className="input mb-2"
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
          />
          <input
            className="input mb-2"
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="New password (min 8)"
            autoComplete="new-password"
          />
          <input
            className="input mb-3"
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
          />
          {err && <p className="mb-3 text-sm text-red-400">{err}</p>}
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary flex-1"
              onClick={submit}
              disabled={busy || !oldPw || !newPw}
            >
              {busy ? "Changing…" : "Change"}
            </button>
          </div>
        </>
      )}
      {done && (
        <div>
          <p className="mb-3 text-sm text-keryx-green">Password changed ✓</p>
          <button className="btn-primary w-full" onClick={reset}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

function ExportWalletSection() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setPassword("");
    setErr(null);
    setBusy(false);
    setExported(null);
  }

  async function doExport() {
    setErr(null);
    setBusy(true);
    try {
      const hex = await wallet.exportWallet(password);
      setPassword("");
      setExported(hex);
      // Trigger a file download of the (encrypted) backup blob.
      try {
        const blob = new Blob([hex], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "keryx-wallet-backup.txt";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        /* download may be blocked; the hex is shown below to copy as a fallback */
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not export wallet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-keryx-border pt-4">
      <h3 className="mb-1 text-sm font-semibold text-keryx-green">
        Export wallet file
      </h3>
      <p className="mb-3 text-xs text-emerald-200/50">
        Save an <b>encrypted</b> backup of your wallet. It is protected by your
        password and can be restored with “Import”. Keep it safe.
      </p>
      {!open && (
        <button className="btn-ghost w-full" onClick={() => setOpen(true)}>
          Export encrypted wallet
        </button>
      )}
      {open && !exported && (
        <>
          <input
            className="input mb-3"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your wallet password"
            autoComplete="current-password"
          />
          {err && <p className="mb-3 text-sm text-red-400">{err}</p>}
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary flex-1"
              onClick={doExport}
              disabled={busy || !password}
            >
              {busy ? "Exporting…" : "Export"}
            </button>
          </div>
        </>
      )}
      {exported && (
        <div>
          <p className="mb-2 text-sm text-keryx-green">
            Saved “keryx-wallet-backup.txt”. If it didn’t download, copy below:
          </p>
          <textarea
            readOnly
            className="input mb-2 h-20 break-all font-mono text-[10px]"
            value={exported}
          />
          <div className="flex gap-2">
            <button
              className="btn-ghost flex-1"
              onClick={() => navigator.clipboard?.writeText(exported)}
            >
              Copy
            </button>
            <button className="btn-primary flex-1" onClick={reset}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RevealPhraseSection() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setOpen(false);
    setPassword("");
    setPhrase(null);
    setErr(null);
    setCopied(false);
  }

  function onReveal() {
    setErr(null);
    try {
      const p = wallet.revealMnemonic(password);
      setPhrase(p);
      setPassword(""); // don't keep the secret in the input
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reveal the phrase.");
    }
  }

  function copyPhrase() {
    if (!phrase) return;
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

  return (
    <div className="border-t border-keryx-border pt-4">
      <h3 className="mb-1 text-sm font-semibold text-keryx-green">
        Recovery phrase
      </h3>
      <p className="mb-3 text-xs text-emerald-200/50">
        Reveal your recovery phrase to back it up or import the wallet on
        another device. Anyone with this phrase controls your funds.
      </p>

      {!open && (
        <button className="btn-ghost w-full" onClick={() => setOpen(true)}>
          Reveal recovery phrase
        </button>
      )}

      {open && !phrase && (
        <>
          <input
            className="input mb-3"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your wallet password"
            autoComplete="current-password"
            autoFocus
          />
          {err && <p className="mb-3 text-sm text-red-400">{err}</p>}
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={reset}>
              Cancel
            </button>
            <button
              className="btn-primary flex-1"
              onClick={onReveal}
              disabled={!password}
            >
              Reveal
            </button>
          </div>
        </>
      )}

      {phrase && (
        <>
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">
            Write it down and keep it offline. Never share it or type it into a
            website.
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {phrase.split(" ").map((w, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-lg border border-keryx-border bg-black/30 px-2 py-1.5 text-xs"
              >
                <span className="text-emerald-200/40">{i + 1}.</span>
                <span className="font-mono text-keryx-green/90">{w}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-emerald-200/40">
              {copied ? "Copied — clears in ~60s" : "Writing it down is safer"}
            </span>
            <button className="btn-ghost" onClick={copyPhrase}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button className="btn-primary" onClick={reset}>
              Hide
            </button>
          </div>
        </>
      )}
    </div>
  );
}
