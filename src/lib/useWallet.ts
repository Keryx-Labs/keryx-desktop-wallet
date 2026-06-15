import { useSyncExternalStore } from "react";
import { wallet } from "./wallet";

// Bridge the WalletService observable into React.
export function useWalletState() {
  useSyncExternalStore(
    (cb) => wallet.subscribe(cb),
    () => version
  );
  return wallet;
}

// useSyncExternalStore needs a changing snapshot; we bump a counter on emit.
let version = 0;
wallet.subscribe(() => {
  version++;
});
