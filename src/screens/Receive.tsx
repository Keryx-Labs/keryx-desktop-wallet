import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { wallet } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";

export function Receive({ onClose }: { onClose: () => void }) {
  const w = useWalletState();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (canvasRef.current && w.receiveAddress) {
      QRCode.toCanvas(canvasRef.current, w.receiveAddress, {
        width: 208,
        margin: 1,
        color: { dark: "#4ade80", light: "#0a0f0d" },
      }).catch(() => {});
    }
  }, [w.receiveAddress]);

  function copyAddr() {
    if (!w.receiveAddress) return;
    navigator.clipboard?.writeText(w.receiveAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function newAddress() {
    setErr(null);
    setBusy(true);
    try {
      await wallet.newReceiveAddress();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not derive a new address.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel flex w-full max-w-md flex-col items-center">
        <div className="mb-4 flex w-full items-center justify-between">
          <h2 className="text-lg font-bold text-keryx-green">Receive KRX</h2>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        {w.receiveAddress ? (
          <>
            {w.receiveAddresses.length > 1 && (
              <div className="mb-4 w-full">
                <p className="label">Active address</p>
                <div className="flex flex-col gap-2">
                  {w.receiveAddresses.map((a, i) => {
                    const active = a === w.receiveAddress;
                    return (
                      <button
                        key={a}
                        type="button"
                        onClick={() => {
                          try {
                            wallet.selectReceiveAddress(a);
                          } catch {
                            /* ignore */
                          }
                        }}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                          active
                            ? "border-keryx-green/60 bg-keryx-green/10 text-keryx-green"
                            : "border-keryx-border bg-black/20 text-emerald-100/80 hover:border-keryx-green/40"
                        }`}
                      >
                        <span>
                          Address {i + 1}
                          {active && <span className="ml-1.5 text-[10px]">✓</span>}
                        </span>
                        <span className="font-mono text-[11px] text-emerald-200/50">
                          {a.slice(0, 10)}…{a.slice(-6)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <canvas
              ref={canvasRef}
              className="rounded-xl border border-keryx-border"
            />
            <code className="mt-4 block w-full break-all rounded-lg bg-black/30 p-3 text-center text-xs text-keryx-green/80">
              {w.receiveAddress}
            </code>
            <div className="mt-4 flex w-full gap-2">
              <button className="btn-ghost flex-1" onClick={copyAddr}>
                {copied ? "Copied!" : "Copy address"}
              </button>
              <button
                className="btn-primary flex-1"
                onClick={newAddress}
                disabled={busy || !w.canAddReceiveAddress}
                title={
                  w.canAddReceiveAddress
                    ? "Create another receive address (max 3)"
                    : "Maximum of 3 addresses reached"
                }
              >
                {busy
                  ? "Deriving…"
                  : w.canAddReceiveAddress
                    ? "New address"
                    : "Max reached"}
              </button>
            </div>
            {!w.canAddReceiveAddress && (
              <p className="mt-2 w-full text-center text-xs text-emerald-200/40">
                This wallet keeps up to 3 addresses — switch between them above.
              </p>
            )}
          </>
        ) : (
          <p className="py-12 text-sm text-emerald-200/40">No address yet.</p>
        )}

        {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
      </div>
    </div>
  );
}
