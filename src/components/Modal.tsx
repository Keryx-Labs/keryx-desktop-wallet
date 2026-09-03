import { useEffect, useRef } from "react";
import { useEscToClose } from "../lib/useModal";

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
} as const;

/**
 * The one overlay shell. Send, Receive, Consolidate, Addresses and Settings each used to
 * carry their own copy of this markup with slightly different max-width and max-height,
 * so they drifted apart visually and only some of them closed on Escape.
 */
export function Modal({
  title,
  onClose,
  size = "md",
  children,
}: {
  title: string;
  onClose: () => void;
  size?: keyof typeof SIZES;
  children: React.ReactNode;
}) {
  useEscToClose(onClose);
  const panel = useRef<HTMLDivElement | null>(null);

  // Only claim focus if nothing inside took it — several of these modals autoFocus an
  // input, and stealing that would break typing straight into the form.
  useEffect(() => {
    if (document.activeElement === document.body) panel.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-keryx-bg/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className={`panel max-h-[90vh] w-full overflow-y-auto outline-none ${SIZES[size]}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="section-label mb-0 pt-1">{title}</h2>
          <button
            className="btn-ghost shrink-0 px-2.5 py-1 text-[11px]"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
