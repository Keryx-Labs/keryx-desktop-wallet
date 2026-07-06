import { useCallback, useEffect, useState } from "react";
import { wallet, formatKrxShort } from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";
import { useEscToClose } from "../lib/useModal";

// Account switcher (MetaMask-style). Opens and AUTO-scans the wallet's addresses (no password — uses
// the public-key generator cached at unlock), showing each account with its balance. Each address is
// an independent account: selecting one scopes balance / Received / Sent / sending to it. You can
// create up to 3 addresses in this wallet.

type Account = {
  address: string;
  balanceSompi: bigint;
  kind: "receive" | "change";
  isActive: boolean;
};

export function Addresses({ onClose }: { onClose: () => void }) {
  const w = useWalletState();
  useEscToClose(onClose);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selected, setSelected] = useState<string | null>(w.receiveAddress);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await wallet.listAccounts(30);
      setAccounts(list);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function useSelected() {
    if (!selected) return;
    try {
      wallet.useAccount(selected);
    } catch {
      /* ignore */
    }
    onClose();
  }

  async function createNew() {
    setErr(null);
    setCreating(true);
    try {
      const addr = await wallet.newReceiveAddress();
      setSelected(addr);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create a new address.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Accounts"
    >
      <div className="panel max-h-[90vh] w-full max-w-md overflow-y-auto">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-keryx-green">My addresses</h2>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-emerald-200/60">
          Each address is a separate account of your <b>one wallet</b>. Pick one and the balance,
          Received, Sent and sending all switch to it.
        </p>

        {accounts === null ? (
          <p className="py-8 text-center text-sm text-emerald-200/50">
            Scanning your addresses…
          </p>
        ) : (
          <>
            <ul className="mb-4 space-y-2">
              {accounts.map((a, i) => {
                const isSel = a.address === selected;
                return (
                  <li key={a.address}>
                    <button
                      type="button"
                      onClick={() => setSelected(a.address)}
                      className={`w-full rounded-xl border p-3 text-left transition-colors ${
                        isSel
                          ? "border-keryx-green/60 bg-keryx-green/10"
                          : "border-keryx-border bg-black/20 hover:border-keryx-green/30"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-emerald-100/90">
                          Account {i + 1}
                          {a.isActive && (
                            <span className="ml-2 rounded bg-keryx-green/15 px-1.5 py-0.5 text-[10px] text-keryx-green">
                              active
                            </span>
                          )}
                          {a.kind === "change" && (
                            <span className="ml-2 text-[10px] text-emerald-200/40">change</span>
                          )}
                        </span>
                        <span className="font-mono text-sm font-semibold text-keryx-green">
                          {formatKrxShort(a.balanceSompi)} KRX
                        </span>
                      </div>
                      <code className="mt-1 block break-all text-[11px] text-emerald-200/50">
                        {a.address}
                      </code>
                    </button>
                  </li>
                );
              })}
            </ul>

            <button
              className="btn-primary w-full"
              onClick={useSelected}
              disabled={!selected || selected === w.receiveAddress}
            >
              {selected === w.receiveAddress ? "This account is active" : "Use this account"}
            </button>

            {err && <p className="mt-3 text-sm text-red-400">{err}</p>}

            <button
              className="btn-ghost mt-3 w-full text-xs"
              onClick={() => void createNew()}
              disabled={creating || !w.canAddReceiveAddress}
              title={
                w.canAddReceiveAddress
                  ? "Create a new address (max 3)"
                  : "Maximum of 3 addresses reached"
              }
            >
              {creating
                ? "Creating…"
                : w.canAddReceiveAddress
                  ? "+ Create new address"
                  : "Max 3 addresses reached"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
