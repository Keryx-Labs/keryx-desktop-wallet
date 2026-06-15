import { useState } from "react";
import { wallet, formatKrx, SendEstimate } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";

type Step = "form" | "confirm" | "sending" | "done";

export function Send({ onClose }: { onClose: () => void }) {
  const w = useWalletState();

  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState(""); // KRX string
  const [fee, setFee] = useState(""); // optional priority fee, KRX string
  const [password, setPassword] = useState("");

  const [step, setStep] = useState<Step>("form");
  const [err, setErr] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<SendEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [txids, setTxids] = useState<string[]>([]);
  // Values FROZEN at estimate time. The confirm/send step uses these exact sompi — it never
  // re-parses the editable fields — so what the user confirms is exactly what gets signed (audit C2).
  const [frozen, setFrozen] = useState<{
    dest: string;
    amountSompi: bigint;
    priorityFeeSompi: bigint;
  } | null>(null);

  // Parsed amounts (sompi). Returns null on invalid input.
  function parseAmounts():
    | { amountSompi: bigint; priorityFeeSompi: bigint }
    | null {
    try {
      const amountSompi = wallet.kaspaToSompi(amount);
      if (amountSompi <= 0n) {
        setErr("Amount must be greater than 0.");
        return null;
      }
      if (amountSompi > w.balance.mature) {
        setErr("Amount exceeds your available (mature) balance.");
        return null;
      }
      const priorityFeeSompi = fee.trim()
        ? wallet.kaspaToSompi(fee)
        : 0n;
      if (priorityFeeSompi < 0n) {
        setErr("Priority fee cannot be negative.");
        return null;
      }
      return { amountSompi, priorityFeeSompi };
    } catch {
      setErr("Invalid amount.");
      return null;
    }
  }

  function validateForm(): boolean {
    setErr(null);
    if (w.conn !== "connected") {
      setErr("Not connected to a node.");
      return false;
    }
    if (!w.synced) {
      setErr("Node is not synced yet — please wait.");
      return false;
    }
    if (!wallet.validateAddress(dest)) {
      setErr("Invalid destination address for the active network.");
      return false;
    }
    if (!parseAmounts()) return false;
    return true;
  }

  async function onEstimate() {
    if (!validateForm()) return;
    const parsed = parseAmounts();
    if (!parsed) return;
    setEstimating(true);
    setErr(null);
    try {
      const frozenVals = {
        dest: dest.trim(),
        amountSompi: parsed.amountSompi,
        priorityFeeSompi: parsed.priorityFeeSompi,
      };
      const est = await wallet.estimate(
        frozenVals.dest,
        frozenVals.amountSompi,
        frozenVals.priorityFeeSompi
      );
      setFrozen(frozenVals);
      setEstimate(est);
      setStep("confirm");
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : "Could not estimate the transaction fee."
      );
    } finally {
      setEstimating(false);
    }
  }

  async function onConfirm() {
    setErr(null);
    if (!password) {
      setErr("Enter your password to confirm.");
      return;
    }
    if (!frozen) {
      setErr("Please estimate the transaction again.");
      setStep("form");
      return;
    }
    // Re-validate at confirm time — state may have changed since the estimate (node dropped,
    // fell out of sync, network switched making the address invalid, or balance dropped) (audit A1).
    if (w.conn !== "connected") {
      setErr("Not connected to a node.");
      return;
    }
    if (!w.synced) {
      setErr("Node is not synced — please wait.");
      return;
    }
    if (!wallet.validateAddress(frozen.dest)) {
      setErr("Destination address is not valid for the active network.");
      setStep("form");
      return;
    }
    if (frozen.amountSompi > w.balance.mature) {
      setErr("Amount now exceeds your available balance.");
      setStep("form");
      return;
    }
    setStep("sending");
    try {
      // Send EXACTLY the frozen sompi the user confirmed — never re-parse the fields.
      const ids = await wallet.send(
        password,
        frozen.dest,
        frozen.amountSompi,
        frozen.priorityFeeSompi
      );
      setPassword(""); // never keep the secret around
      setTxids(ids);
      setStep("done");
    } catch (e) {
      setPassword("");
      const msg = e instanceof Error ? e.message : String(e);
      setErr(humanizeSendError(msg));
      setStep("confirm");
    }
  }

  const canSubmit = w.conn === "connected" && w.synced;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel w-full max-w-md">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-keryx-green">Send KRX</h2>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        {!canSubmit && step === "form" && (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
            {w.conn !== "connected"
              ? "Not connected to a node."
              : "Node is still syncing — sending is disabled until synced."}
          </p>
        )}

        {step === "form" && (
          <>
            <label className="label">Destination address</label>
            <input
              className="input mb-1 font-mono"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder={`${w.addressPrefix ?? "keryx"}:…`}
              autoFocus
            />
            {dest.trim() && (
              <p
                className={`mb-3 text-xs ${
                  wallet.validateAddress(dest)
                    ? "text-keryx-green/70"
                    : "text-red-400"
                }`}
              >
                {wallet.validateAddress(dest)
                  ? "Valid address ✓"
                  : "Invalid address for the active network."}
              </p>
            )}

            <label className="label mt-2">Amount (KRX)</label>
            <input
              className="input mb-1 font-mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.0"
            />
            <p className="mb-3 text-xs text-emerald-200/40">
              Available: {formatKrx(w.balance.mature)} KRX
            </p>

            <label className="label mt-2">Priority fee (KRX, optional)</label>
            <input
              className="input mb-5 font-mono"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              inputMode="decimal"
              placeholder="0.0"
            />

            {err && <p className="mb-3 text-sm text-red-400">{err}</p>}

            <button
              className="btn-primary w-full"
              onClick={onEstimate}
              disabled={estimating || !canSubmit}
            >
              {estimating ? "Estimating…" : "Estimate fee"}
            </button>
          </>
        )}

        {(step === "confirm" || step === "sending") && estimate && frozen && (
          <>
            <div className="mb-4 space-y-3 rounded-xl border border-keryx-border bg-black/20 p-4">
              <Row label="To">
                <code className="break-all text-xs text-keryx-green/80">
                  {frozen.dest}
                </code>
              </Row>
              <Row label="Amount">
                <span className="font-semibold text-keryx-green">
                  {formatKrx(frozen.amountSompi)} KRX
                </span>
              </Row>
              <Row label="Network fee (est.)">
                <span className="text-emerald-100/80">
                  {formatKrx(estimate.feeSompi)} KRX
                </span>
              </Row>
              <Row label="Total (est.)">
                <span className="font-semibold text-keryx-green">
                  {formatKrx(estimate.totalSompi)} KRX
                </span>
              </Row>
            </div>

            <label className="label">Confirm with your password</label>
            <input
              className="input mb-4"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Wallet password"
              autoComplete="current-password"
              disabled={step === "sending"}
              autoFocus
            />

            {err && <p className="mb-3 text-sm text-red-400">{err}</p>}

            <div className="flex gap-2">
              <button
                className="btn-ghost flex-1"
                onClick={() => {
                  setStep("form");
                  setErr(null);
                }}
                disabled={step === "sending"}
              >
                Back
              </button>
              <button
                className="btn-primary flex-1"
                onClick={onConfirm}
                disabled={step === "sending"}
              >
                {step === "sending" ? "Sending…" : "Confirm & send"}
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <div className="text-center">
            <p className="mb-3 text-lg font-bold text-keryx-green">Sent ✓</p>
            <p className="mb-3 text-sm text-emerald-100/70">
              {txids.length === 1
                ? "Transaction submitted:"
                : `${txids.length} transactions submitted:`}
            </p>
            <div className="mb-5 space-y-1">
              {txids.map((id) => (
                <code
                  key={id}
                  className="block break-all rounded-lg bg-black/30 p-2 text-xs text-keryx-green/80"
                >
                  {id}
                </code>
              ))}
            </div>
            <button className="btn-primary w-full" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-emerald-200/50">
        {label}
      </span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function humanizeSendError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("insufficient") || m.includes("not enough")) {
    return "Insufficient funds for this amount plus fees.";
  }
  if (m.includes("secret") || m.includes("decrypt") || m.includes("password")) {
    return "Wrong password.";
  }
  if (m.includes("address")) {
    return "Invalid destination address.";
  }
  if (m.includes("connect")) {
    return "Not connected to a node.";
  }
  return msg;
}
