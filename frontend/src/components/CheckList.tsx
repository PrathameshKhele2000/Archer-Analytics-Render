import { useMemo, useState } from "react";

export interface CheckOption {
  id: number;
  label: string;
  /** Secondary line (e.g. an email under a name). */
  sub?: string;
}

/**
 * A framed, scrollable checkbox list for picking several items — the readable
 * alternative to a dropdown when the choice matters (roles, users, views). Shows a
 * live count, select-all / clear, and a search box once the list is long enough to
 * need one. Selection is controlled by the parent.
 */
export default function CheckList({
  options, selected, onChange, searchPlaceholder = "Search…", emptyText = "Nothing to choose.", maxHeight = 220,
}: {
  options: CheckOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  maxHeight?: number;
}) {
  const [q, setQ] = useState("");
  const showSearch = options.length > 6;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return options;
    return options.filter((o) => o.label.toLowerCase().includes(term) || o.sub?.toLowerCase().includes(term));
  }, [options, q]);

  const set = new Set(selected);
  const toggle = (id: number) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  // Select-all acts on what's currently visible (respects the search filter).
  const allVisibleSelected = filtered.length > 0 && filtered.every((o) => set.has(o.id));
  const toggleAll = () => {
    const next = new Set(set);
    if (allVisibleSelected) filtered.forEach((o) => next.delete(o.id));
    else filtered.forEach((o) => next.add(o.id));
    onChange([...next]);
  };

  return (
    <div className="checklist">
      <div className="checklist-bar">
        <span className="checklist-count">{selected.length} selected</span>
        {options.length > 0 && (
          <button type="button" className="link-btn" onClick={toggleAll}>
            {allVisibleSelected ? "Clear all" : "Select all"}
          </button>
        )}
      </div>
      {showSearch && (
        <input className="checklist-search" value={q} onChange={(e) => setQ(e.target.value)}
               placeholder={searchPlaceholder} aria-label="Filter options" />
      )}
      <div className="checklist-items" style={{ maxHeight }}>
        {options.length === 0 ? (
          <div className="checklist-empty">{emptyText}</div>
        ) : filtered.length === 0 ? (
          <div className="checklist-empty">No matches.</div>
        ) : (
          filtered.map((o) => (
            <label key={o.id} className={`checklist-item${set.has(o.id) ? " on" : ""}`}>
              <input type="checkbox" checked={set.has(o.id)} onChange={() => toggle(o.id)} />
              <span className="checklist-label">
                {o.label}
                {o.sub && <span className="checklist-sub">{o.sub}</span>}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
