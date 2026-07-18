import { useEffect, useRef, useState } from "react";

const ITEMS: { kind: "csv" | "excel" | "pdf"; label: string; icon: string }[] = [
  { kind: "csv", label: "CSV", icon: "▤" },
  { kind: "excel", label: "Excel", icon: "▦" },
  { kind: "pdf", label: "PDF", icon: "▧" },
];

/** Single "Export ▾" button that opens a dropdown of formats — matches the app's control style. */
export default function ExportMenu({
  onExport, busy,
}: {
  onExport: (kind: "csv" | "excel" | "pdf") => void;
  busy?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="export-menu" ref={ref}>
      <button className="export-toggle" onClick={() => setOpen((o) => !o)} disabled={!!busy}
              aria-haspopup="menu" aria-expanded={open}>
        {busy ? `Exporting ${busy.toUpperCase()}…` : "Export"} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="export-dropdown" role="menu">
          {ITEMS.map((it) => (
            <button key={it.kind} role="menuitem" onClick={() => { setOpen(false); onExport(it.kind); }}>
              <span className="ex-icon">{it.icon}</span> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
