import { useEffect, useMemo, useState } from "react";
import { api, FieldsCatalog, FilterCondition, Page, ReportConfig } from "../api";
import ExportMenu from "./ExportMenu";
import FilterConditions from "./FilterConditions";
import VirtualTable, { VCol } from "./VirtualTable";

const COL_WIDTH: Record<string, number> = {
  record_id: 100, device_name: 160, computer_name: 160, cve: 150, cve_type: 150,
  priority: 90, age: 90, device_status: 130, record_status: 130, business_unit: 150,
  days_open: 100, first_found_date: 130, closed_date: 130, last_updated: 160,
};
const NUMERIC_COLS = new Set(["record_id", "days_open", "first_found_date", "closed_date", "last_updated"]);

function cellText(v: unknown): string {
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function renderCell(key: string, row: any) {
  const text = cellText(row[key]);
  return NUMERIC_COLS.has(key) ? <span className="num">{text}</span> : text;
}

/** Renders any registered report. Columns come from report config; filtering is a dynamic
 *  field/operator/value condition builder backed by the server-side filter engine. */
export default function ReportView({ reportKey }: { reportKey: string }) {
  const [config, setConfig] = useState<ReportConfig | null>(null);
  const [catalog, setCatalog] = useState<FieldsCatalog | null>(null);
  const [data, setData] = useState<Page | null>(null);
  const [page, setPage] = useState(1);
  const [conditions, setConditions] = useState<FilterCondition[]>([]); // being edited
  const [logic, setLogic] = useState("");
  const [applied, setApplied] = useState<{ conditions: FilterCondition[]; logic: string } | null>(null);
  const [sort, setSort] = useState("first_found_date");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSize] = useState(100); // sweet spot: fast + plenty of rows
  const [search, setSearch] = useState("");                       // global quick-search
  const [colFilters, setColFilters] = useState<Record<string, string>>({}); // per-column
  const [dSearch, setDSearch] = useState("");                     // debounced
  const [dCols, setDCols] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    api.reports.config(reportKey).then(setConfig).catch(console.error);
    api.reports.fields(reportKey).then(setCatalog).catch(console.error);
  }, [reportKey]);

  // Debounce quick-search so we don't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setDSearch(search); setDCols(colFilters); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search, colFilters]);

  const query = useMemo(() => {
    const q: Record<string, string> = { page: String(page), size: String(pageSize), sort, order };
    if (applied && applied.conditions.length) {
      q.filters = JSON.stringify(applied.conditions);
      if (applied.logic.trim()) q.logic = applied.logic.trim();
    }
    if (dSearch.trim()) q.search = dSearch.trim();
    const activeCols = Object.fromEntries(Object.entries(dCols).filter(([, v]) => v.trim()));
    if (Object.keys(activeCols).length) q.cols = JSON.stringify(activeCols);
    return q;
  }, [page, pageSize, sort, order, applied, dSearch, dCols]);

  useEffect(() => {
    api.reports.data(reportKey, query).then(setData).catch((e) => console.error(e));
  }, [reportKey, query]);

  const applyFilters = () => { setApplied({ conditions, logic }); setPage(1); setShowFilters(false); };
  const clearFilters = () => { setConditions([]); setLogic(""); setApplied(null); setPage(1); };
  const appliedCount = applied?.conditions.length ?? 0;

  const columns = (config?.columns ?? []).filter((c) => c.is_default_visible);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const toggleSort = (col: string, sortable: boolean) => {
    if (!sortable) return;
    if (sort === col) setOrder(order === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder("desc"); }
  };

  const runExport = async (kind: "csv" | "excel" | "pdf") => {
    setExporting(kind);
    try {
      if (kind === "csv") await api.reports.exportCsv(reportKey, query);
      else if (kind === "excel") await api.reports.exportExcel(reportKey, query);
      else await api.reports.exportPdf(reportKey, query);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="panel report" aria-label={config?.report.name ?? "Report"}>
      <div className="report-head">
        <h2>{config?.report.name ?? "Report"}</h2>
        <div className="report-tools">
          <div className="search-box">
            <span className="search-icon">⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
                   placeholder="Search all records…" aria-label="Search records" />
            {search && <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">✕</button>}
          </div>
          <button className={`filter-toggle${appliedCount ? " has-filters" : ""}`}
                  onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <span className="funnel">⛃</span> {appliedCount ? "Filters" : "Add filters"}
            {appliedCount > 0 && <span className="filter-count">{appliedCount}</span>}
            <span className="caret">{showFilters ? "▴" : "▾"}</span>
          </button>
          <ExportMenu onExport={runExport} busy={exporting} />
        </div>
      </div>

      {appliedCount > 0 && !showFilters && (
        <div className="active-filters">
          <span>{appliedCount} filter{appliedCount > 1 ? "s" : ""} active{applied?.logic ? ` · logic: ${applied.logic}` : ""}</span>
          <button className="link-btn" onClick={clearFilters}>Clear</button>
        </div>
      )}

      {catalog && showFilters && (
        <div className="filter-builder">
          <div className="fb-title">Filter conditions</div>
          <FilterConditions conditions={conditions} logic={logic} catalog={catalog}
                            onChange={(c, l) => { setConditions(c); setLogic(l); }} />
          <div className="fb-apply-bar">
            <button onClick={clearFilters}>Clear</button>
            <button className="primary" onClick={applyFilters} disabled={!conditions.length}>Apply filters</button>
          </div>
        </div>
      )}

      {!data ? (
        <div className="loading">loading…</div>
      ) : (
        <>
          <VirtualTable
            columns={columns.map((c): VCol => ({ key: c.key, label: c.label, width: COL_WIDTH[c.key] ?? 150, sortable: c.sortable }))}
            rows={data.rows}
            renderCell={renderCell}
            sort={sort}
            order={order}
            onSort={toggleSort}
            colFilters={colFilters}
            onColFilter={(key, value) => setColFilters((f) => ({ ...f, [key]: value }))}
          />
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>page {data.page} of {pages} · {data.rows.length.toLocaleString()} shown of {data.totalEstimated ? "~" : ""}{data.total.toLocaleString()}{data.totalCapped ? "+" : ""}</span>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            <label className="page-size">
              Rows
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                <option value={100}>100</option>
                <option value={1000}>1,000</option>
                <option value={10000}>10,000</option>
                <option value={50000}>50,000</option>
              </select>
            </label>
          </div>
        </>
      )}
    </section>
  );
}
