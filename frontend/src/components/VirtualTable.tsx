import { ReactNode, useEffect, useRef, useState } from "react";

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLDivElement>(null);
  // Guards against the two onScroll handlers re-triggering each other in a loop when
  // one sets the other's scrollLeft.
  const syncSource = useRef<"real" | "proxy" | null>(null);

  const total = rows.length;
  const overscan = 6;
  const visible = Math.ceil(height / rowHeight) + overscan;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, start + visible);
  const slice = rows.slice(start, end);

  const template = columns.map((c) => `${c.width}px`).join(" ");
  const minWidth = columns.reduce((a, c) => a + c.width, 0);

  // The real horizontal scrollbar sits at the bottom of the table's own box, which can
  // land below the fold on a short viewport — reaching it means scrolling the whole
  // page down first. This tracks a second, thin scrollbar fixed to the bottom of the
  // VIEWPORT while any part of the table is on screen but its own bottom edge isn't yet
  // (`rect.bottom > innerHeight`) — once the real scrollbar itself has scrolled into
  // view, the copy hides so it never floats over the content below the table.
  const [proxyRect, setProxyRect] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    const recompute = () => {
      const el = scrollRef.current;
      if (!el) { setProxyRect(null); return; }
      const rect = el.getBoundingClientRect();
      const show = rect.top < window.innerHeight && rect.bottom > window.innerHeight && rect.width > 0;
      setProxyRect(show ? { left: rect.left, width: rect.width } : null);
    };
    recompute();
    window.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [minWidth]);

  // A freshly-mounted proxy starts at scrollLeft 0 even if the real table is already
  // scrolled sideways — line it up the moment it appears.
  useEffect(() => {
    if (proxyRect && proxyRef.current && scrollRef.current) {
      proxyRef.current.scrollLeft = scrollRef.current.scrollLeft;
    }
  }, [!!proxyRect]);

  return (
    <div className="vtable">
      <div
        className="vtable-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          if (syncSource.current === "proxy") { syncSource.current = null; return; }
          if (proxyRef.current) { syncSource.current = "real"; proxyRef.current.scrollLeft = e.currentTarget.scrollLeft; }
        }}
      >
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
      {proxyRect && (
        <div className="vt-hscroll-fixed" style={{ left: proxyRect.left, width: proxyRect.width }}
             ref={proxyRef}
             onScroll={(e) => {
               if (syncSource.current === "real") { syncSource.current = null; return; }
               if (scrollRef.current) { syncSource.current = "proxy"; scrollRef.current.scrollLeft = e.currentTarget.scrollLeft; }
             }}>
          <div style={{ width: minWidth, height: 1 }} />
        </div>
      )}
    </div>
  );
}
