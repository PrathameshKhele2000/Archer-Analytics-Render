import { ReactNode, useRef, useState } from "react";

export interface VCol {
  key: string;
  label: string;
  width: number;
  sortable?: boolean;
}

/**
 * Windowed (virtualized) table: only the rows in the viewport are in the DOM, so it
 * scrolls smoothly through tens of thousands of rows. Fixed row height keeps the math
 * simple; a horizontal scroll wrapper keeps wide tables inside their container.
 */
export default function VirtualTable({
  columns, rows, renderCell, sort, order, onSort, colFilters, onColFilter, rowHeight = 36, height = 560,
}: {
  columns: VCol[];
  rows: any[];
  renderCell: (key: string, row: any) => ReactNode;
  sort?: string;
  order?: "asc" | "desc";
  onSort?: (key: string, sortable: boolean) => void;
  colFilters?: Record<string, string>;
  onColFilter?: (key: string, value: string) => void;
  rowHeight?: number;
  height?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const total = rows.length;
  const overscan = 6;
  const visible = Math.ceil(height / rowHeight) + overscan;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, start + visible);
  const slice = rows.slice(start, end);

  const template = columns.map((c) => `${c.width}px`).join(" ");
  const minWidth = columns.reduce((a, c) => a + c.width, 0);

  return (
    <div className="vtable">
      <div style={{ minWidth }}>
        <div className="vt-head" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => (
            <div key={c.key} className={`vt-cell${c.sortable ? " sortable" : ""}`}
                 onClick={() => onSort?.(c.key, !!c.sortable)}>
              {c.label}{sort === c.key ? (order === "asc" ? " ↑" : " ↓") : ""}
            </div>
          ))}
        </div>
        {onColFilter && (
          <div className="vt-filter" style={{ gridTemplateColumns: template }}>
            {columns.map((c) => (
              <div key={c.key} className="vt-cell">
                <input value={colFilters?.[c.key] ?? ""} placeholder="search…"
                       onChange={(e) => onColFilter(c.key, e.target.value)} />
              </div>
            ))}
          </div>
        )}
        <div className="vt-body" style={{ height }} ref={bodyRef}
             onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: total * rowHeight, position: "relative" }}>
            {slice.map((r, i) => (
              <div key={r.record_id ?? start + i} className="vt-row"
                   style={{ position: "absolute", top: (start + i) * rowHeight, height: rowHeight,
                            display: "grid", gridTemplateColumns: template, width: "100%" }}>
                {columns.map((c) => (
                  <div key={c.key} className="vt-cell">{renderCell(c.key, r)}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
