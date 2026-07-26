import { useEffect, useMemo, useRef, useState } from "react";
import { api, DatasetColumn, DatasetSchema, DatasetSummary, FilterCondition, Page } from "../api";
import ExportMenu from "./ExportMenu";
import FilterConditions from "./FilterConditions";
import VirtualTable, { VCol } from "./VirtualTable";

const nf = new Intl.NumberFormat();

function cellText(v: unknown): string {
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) {
    return v.length ? v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "—";
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Wide enough for the header, wider for free-text columns, narrow for ids/numbers. */
function widthFor(col: DatasetColumn): number {
  const header = col.label.length * 8 + 34;
  if (col.key === "record_id") return Math.max(110, header);
  if (col.numeric) return Math.max(120, Math.min(header, 190));
  return Math.max(150, Math.min(header, 260));
}

function whenText(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

/** Dataset picker + the same summary a card used to show (description, row/column
 *  counts, source→target mapping), now a dropdown so it sits inline with the search
 *  bar instead of a whole row of cards above the table. */
function DatasetSelect({
  datasets, active, onPick,
}: { datasets: DatasetSummary[]; active: DatasetSummary; onPick: (key: string) => void }) {
  return (
    <div className="ds-select-block">
      <select value={active.key} onChange={(e) => onPick(e.target.value)} aria-label="Choose dataset">
        {datasets.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
      </select>
      <span className="ds-select-info">
        <span className="ds-select-stats">
          <strong>{active.rowCountEstimated ? "~" : ""}{nf.format(active.rowCount)}</strong> rows
          <span className="ds-select-sep">·</span>
          <strong>{nf.format(active.columnCount)}</strong> columns
        </span>
        <span className="ds-select-map">
          {active.sourceTable ? <>{active.sourceTable} <span className="ds-arrow"></span> </> : null}
        </span>
      </span>
    </div>
  );
}

/** The full table for one dataset: every mapped column, every row. */
function DatasetTable({
  dataset, datasets, onPick,
}: { dataset: DatasetSummary; datasets: DatasetSummary[]; onPick: (key: string) => void }) {
  const [schema, setSchema] = useState<DatasetSchema | null>(null);
  const [data, setData] = useState<Page | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [sort, setSort] = useState("record_id");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [dSearch, setDSearch] = useState("");
  const [dCols, setDCols] = useState<Record<string, string>>({});
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [logic, setLogic] = useState("");
  const [applied, setApplied] = useState<{ conditions: FilterCondition[]; logic: string } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Switching datasets resets everything — a filter or sort on one dataset's columns
  // is meaningless on another's and would 400 the next query.
  useEffect(() => {
    setSchema(null); setData(null); setPage(1);
    setSearch(""); setColFilters({}); setDSearch(""); setDCols({});
    setConditions([]); setLogic(""); setApplied(null); setShowFilters(false); setError(null);
    api.datasets.schema(dataset.key)
      .then((s) => { setSchema(s); setSort(s.defaultSort); setOrder("desc"); })
      .catch((e) => setError(e.message ?? "Could not load dataset schema"));
  }, [dataset.key]);

  useEffect(() => {
    const t = setTimeout(() => { setDSearch(search); setDCols(colFilters); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search, colFilters]);

  const query = useMemo(() => {
    const q: Record<string, string> = { page: String(page), size: String(pageSize), sort, order };
    if (applied?.conditions.length) {
      q.filters = JSON.stringify(applied.conditions);
      if (applied.logic.trim()) q.logic = applied.logic.trim();
    }
    if (dSearch.trim()) q.search = dSearch.trim();
    const active = Object.fromEntries(Object.entries(dCols).filter(([, v]) => v.trim()));
    if (Object.keys(active).length) q.cols = JSON.stringify(active);
    return q;
  }, [page, pageSize, sort, order, applied, dSearch, dCols]);

  // Paging/filtering fires a new request before the previous one resolves; a slow
  // earlier response (cache miss) landing after a fast later one (cache hit) would
  // otherwise overwrite the current page with stale data. Only the most recent request
  // in flight is allowed to update state.
  const requestSeq = useRef(0);
  useEffect(() => {
    if (!schema) return;
    const seq = ++requestSeq.current;
    setError(null);
    api.datasets.data(dataset.key, query)
      .then((res) => { if (seq === requestSeq.current) setData(res); })
      .catch((e) => { if (seq === requestSeq.current) setError(e.message ?? "Query failed"); });
  }, [dataset.key, schema, query]);

  const numericKeys = useMemo(
    () => new Set((schema?.columns ?? []).filter((c) => c.numeric).map((c) => c.key)),
    [schema],
  );
  const renderCell = (key: string, row: any) => {
    const text = cellText(row[key]);
    return numericKeys.has(key) ? <span className="num">{text}</span> : text;
  };

  const toggleSort = (col: string, sortable: boolean) => {
    if (!sortable) return;
    if (sort === col) setOrder(order === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder("desc"); }
    setPage(1);
  };

  const runExport = async (kind: "csv" | "excel" | "pdf") => {
    setExporting(kind);
    try {
      const { page: _p, size: _s, sort: _so, order: _o, ...filters } = query;
      if (kind === "csv") await api.datasets.exportCsv(dataset.key, filters);
      else if (kind === "excel") await api.datasets.exportExcel(dataset.key, filters);
      else await api.datasets.exportPdf(dataset.key, filters);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(null);
    }
  };

  const appliedCount = applied?.conditions.length ?? 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  if (error && !schema) return <div className="loading">{error}</div>;
  if (!schema) return <div className="loading">loading dataset…</div>;

  return (
    <>
      <div className="report-head">
        <DatasetSelect datasets={datasets} active={dataset} onPick={onPick} />
        <div className="report-tools">
          <div className="search-box">
            <span className="search-icon">⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
                   placeholder="Search all rows…" aria-label="Search dataset" />
            {search && <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">✕</button>}
          </div>
          <button className={`filter-toggle${appliedCount ? " has-filters" : ""}`}
                  onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <span className="funnel"></span> {appliedCount ? "Filters" : "Add Filters"}
            {appliedCount > 0 && <span className="filter-count">{appliedCount}</span>}
            <span className="caret">{showFilters ? "▴" : "▾"}</span>
          </button>
          <ExportMenu onExport={runExport} busy={exporting} />
        </div>
      </div>

      {appliedCount > 0 && !showFilters && (
        <div className="active-filters">
          <span>{appliedCount} filter{appliedCount > 1 ? "s" : ""} active{applied?.logic ? ` · logic: ${applied.logic}` : ""}</span>
          <button className="link-btn" onClick={() => { setConditions([]); setLogic(""); setApplied(null); setPage(1); }}>Clear</button>
        </div>
      )}

      {showFilters && (
        <div className="filter-builder">
          <div className="fb-title">Filter conditions</div>
          <FilterConditions conditions={conditions} logic={logic} catalog={schema}
                            onChange={(c, l) => { setConditions(c); setLogic(l); }} />
          <div className="fb-apply">
            <button onClick={() => { setConditions([]); setLogic(""); setApplied(null); setPage(1); }}>Clear</button>
            <button className="primary" disabled={!conditions.length}
                    onClick={() => { setApplied({ conditions, logic }); setPage(1); setShowFilters(false); }}>
              Apply filters
            </button>
          </div>
        </div>
      )}

      {error && <div className="login-error">{error}</div>}

      {!data ? (
        <div className="loading">loading…</div>
      ) : (
        <>
          <VirtualTable
            columns={schema.columns.map((c): VCol => ({
              key: c.key, label: c.label, width: widthFor(c), sortable: c.sortable,
            }))}
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
            <span>
              page {data.page} of {nf.format(pages)} · {nf.format(data.rows.length)} shown of{" "}
              {data.totalEstimated ? "~" : ""}{nf.format(data.total)}{data.totalCapped ? "+" : ""}
            </span>
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
    </>
  );
}

/**
 * The DataSets tab: every data source that has been registered and mapped, with its
 * complete contents. Where the Records tab shows curated views (a chosen subset of
 * columns, optionally scoped), this shows the table exactly as the mapping built it.
 */
export default function DataSetsTab() {
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.datasets.list()
      .then((rows) => {
        setDatasets(rows);
        setActiveKey((cur) => (cur && rows.some((r) => r.key === cur) ? cur : rows[0]?.key ?? null));
      })
      .catch((e) => setError(e.message ?? "Could not load datasets"));
  }, []);

  if (error) return <section className="panel"><div className="loading">{error}</div></section>;
  if (!datasets) return <section className="panel"><div className="loading">loading datasets…</div></section>;
  if (!datasets.length) {
    return (
      <section className="panel">
        <div className="loading">
          No datasets yet. Register a data source and map its columns in Admin Panel → Data Sources.
        </div>
      </section>
    );
  }

  const active = datasets.find((d) => d.key === activeKey) ?? null;

  return (
    <section className="panel report" aria-label="Data sets">
      {active ? <DatasetTable key={active.key} dataset={active} datasets={datasets} onPick={setActiveKey} /> : null}
    </section>
  );
}
