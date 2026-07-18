import { useEffect, useRef, useState } from "react";

export interface MultiOpt { key: string; label: string; }

/** A compact dropdown whose menu is a multi-select checklist. Closes on outside click / Escape. */
export default function MultiCheckDropdown({
  label, options, selected, onToggle,
}: {
  label: string;
  options: MultiOpt[];
  selected: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const count = options.filter((o) => selected(o.key)).length;

  return (
    <div className="multi-dropdown" ref={ref}>
      <button type="button" className="multi-toggle" onClick={() => setOpen((o) => !o)}
              aria-haspopup="true" aria-expanded={open}>
        {label} <span className="multi-count">{count}</span> <span className="caret">▾</span>
      </button>
      {open && (
        <div className="multi-menu" role="menu">
          {options.map((o) => (
            <label className="multi-item" key={o.key}>
              <input type="checkbox" checked={selected(o.key)} onChange={() => onToggle(o.key)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
