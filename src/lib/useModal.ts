import { useEffect } from "react";

/**
 * Close a modal when the user presses Escape. Attaches a keydown listener for the
 * modal's lifetime. Purely additive — does not change any existing behaviour.
 */
export function useEscToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
