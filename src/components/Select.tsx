import { useEffect, useRef, useState } from "react";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

/** Themed replacement for a native `<select>`: the platform popup cannot be styled. */
export function Select<V extends string>({
  value,
  options,
  onChange,
  disabled,
  className = "",
  title,
}: {
  value: V;
  options: SelectOption<V>[];
  onChange: (v: V) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={`relative ${className}`} title={title}>
      <button
        type="button"
        className="input flex items-center justify-between gap-3 text-left disabled:opacity-60"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`shrink-0 text-keryx-green transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-sm border border-keryx-green/40 bg-keryx-surface py-1 shadow-lg shadow-black/60"
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={active}
                className={`cursor-pointer px-3.5 py-2 text-sm ${
                  active
                    ? "bg-keryx-green/15 text-keryx-green"
                    : "text-keryx-ink hover:bg-keryx-green/10 hover:text-keryx-green"
                }`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
