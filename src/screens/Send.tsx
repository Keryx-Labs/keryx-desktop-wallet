import { useState } from "react";
import {
  wallet,
  formatKrx,
  groupKrx,
  normalizeAmountInput,
  SendEstimate,
} from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import { Modal } from "../components/Modal";

type Step = "form" | "confirm" | "sending" | "done";

/**
 * Held back by "send max" so the node still has room to charge the network fee. The real fee
 * comes from wallet.estimate() and is far smaller than this; 0.3 KRX is a deliberately
 * generous cushion so a max-send is never rejected for being a few sompi short.
 */
const MAX_SEND_FEE_RESERVE = 30_000_000n; // 0.3 KRX, in sompi

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
    const parsedAmount = normalizeAmountInput(amount);
    if ("error" in parsedAmount) {
      setErr(parsedAmount.error);
      return null;
    }
    let normalizedFee: string | null = null;
    if (fee.trim()) {
      const parsedFee = normalizeAmountInput(fee);
      if ("error" in parsedFee) {
        setErr(parsedFee.error);
        return null;
      }
      normalizedFee = parsedFee.value;
    }
    try {
      // Always the normalized string — the node takes a plain decimal, never our display form.
      const amountSompi = wallet.kaspaToSompi(parsedAmount.value);
      if (amountSompi <= 0n) {
        setErr("Amount must be greater than 0.");
        return null;
      }
      if (amountSompi > w.balance.mature) {
        setErr("Amount exceeds your available (mature) balance.");
        return null;
      }
      const priorityFeeSompi = normalizedFee
        ? wallet.kaspaToSompi(normalizedFee)
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
      setErr("Node is not synced yet. Please wait.");
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
      setErr("Node is not synced. Please wait.");
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

  // The most that can go out in one send: the mature balance minus the fee cushion. Clamped at
  // zero so a dust balance doesn't offer a negative "max".
  const maxSendable =
    w.balance.mature > MAX_SEND_FEE_RESERVE
      ? w.balance.mature - MAX_SEND_FEE_RESERVE
      : 0n;

  function fillMax() {
    setAmount(groupKrx(formatKrx(maxSendable)));
    setErr(null);
  }

  // Echo how the field will actually be read, so a mistyped separator is caught before the
  // estimate step rather than at the confirm screen.
  const amountEcho = (() => {
    if (!amount.trim()) return null;
    const n = normalizeAmountInput(amount);
    if ("error" in n) return { error: n.error };
    try {
      const shown = groupKrx(formatKrx(wallet.kaspaToSompi(n.value)));
      // Always show a decimal place: "1,234" is read as one thousand two hundred thirty-four
      // here, and echoing it as "1,234.0" makes that unmistakable to anyone who meant 1.234.
      return { text: shown.includes(".") ? shown : `${shown}.0` };
    } catch {
      return { error: "Invalid amount." };
    }
  })();

  return (
    <Modal title="Send KRX" onClose={onClose}>
      {!canSubmit && step === "form" && (
        <p className="mb-4 rounded-sm border border-keryx-warn/40 bg-keryx-warn/10 p-2.5 text-xs leading-relaxed text-keryx-warn">
          {w.conn !== "connected"
            ? "Not connected to a node."
            : "Node is still syncing. Sending is disabled until it catches up."}
        </p>
      )}

      {step === "form" && (
        <>
          <label className="label">Destination address</label>
          <input
            className="input mb-1"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder={`${w.addressPrefix ?? "keryx"}:…`}
            autoFocus
          />
          {dest.trim() && (
            <p
              className={`mb-3 text-xs ${
                wallet.validateAddress(dest)
                  ? "text-keryx-green"
                  : "text-keryx-error"
              }`}
            >
              {wallet.validateAddress(dest)
                ? "Valid address ✓"
                : "Invalid address for the active network."}
            </p>
          )}

          <label className="label mt-2">Amount (KRX)</label>
          <input
            className="input mb-1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
          />
          {amountEcho && (
            <p
              className={`num mb-1 text-xs ${
                "error" in amountEcho ? "text-keryx-error" : "text-keryx-mid"
              }`}
            >
              {"error" in amountEcho
                ? amountEcho.error
                : `= ${amountEcho.text} KRX`}
            </p>
          )}
          <p className="mb-3 text-xs text-keryx-dim">
            {maxSendable > 0n ? (
              <button
                type="button"
                className="num text-keryx-green underline decoration-dotted underline-offset-2 transition-colors hover:text-keryx-bright"
                onClick={fillMax}
                title={`Fill in ${formatKrx(maxSendable)} KRX — everything except 0.3 KRX kept back for the network fee`}
              >
                Available: {groupKrx(formatKrx(w.balance.mature))} KRX
              </button>
            ) : (
              <span className="num">
                Available: {groupKrx(formatKrx(w.balance.mature))} KRX
              </span>
            )}
            {maxSendable > 0n && (
              <span className="text-keryx-dim">
                {" "}
                · click to send max (keeps 0.3 KRX for fees)
              </span>
            )}
          </p>

          <label className="label mt-2">Priority fee (KRX, optional)</label>
          <input
            className="input mb-5"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
          />

          {err && <p className="mb-3 text-sm text-keryx-error">{err}</p>}

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
          <div className="card mb-4 space-y-3 p-4">
            <Row label="To">
              <code className="break-all text-xs text-keryx-green">
                {frozen.dest}
              </code>
            </Row>
            <Row label="Amount">
              <span className="num font-semibold text-keryx-bright">
                {formatKrx(frozen.amountSompi)} KRX
              </span>
            </Row>
            <Row label="Network fee (est.)">
              <span className="num text-keryx-ink">
                {formatKrx(estimate.feeSompi)} KRX
              </span>
            </Row>
            <Row label="Total (est.)">
              <span className="num font-semibold text-keryx-bright">
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

          {err && <p className="mb-3 text-sm text-keryx-error">{err}</p>}

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
          <p className="glow mb-3 text-sm font-bold uppercase tracking-label text-keryx-bright">
            Sent ✓
          </p>
          <p className="mb-3 text-sm leading-relaxed text-keryx-text">
            {txids.length === 1
              ? "Transaction submitted:"
              : `${txids.length} transactions submitted:`}
          </p>
          <div className="mb-5 space-y-1">
            {txids.map((id) => (
              <code
                key={id}
                className="block break-all rounded-sm border border-keryx-border bg-keryx-green/[0.03] p-2 text-xs text-keryx-green"
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
    </Modal>
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
      <span className="text-[10px] uppercase tracking-label text-keryx-dim">
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
