import { useEffect, useMemo, useRef, useState } from "react";
import { api, DashboardWidget, DrillStep, Finding, isRolledUpGroup, QueryRow } from "../api";
import { buildCsv, downloadText } from "../csv";
import { formatCell } from "../recordColumns";
import ExportMenu from "./ExportMenu";
import GenericChart, { legendNames, paletteOf, SeriesLegend } from "./GenericChart";
import VirtualTable, { VCol } from "./VirtualTable";

const humanize = (k?: string | null) => (k ? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");

/** Records table shown at the deepest drill level (the raw findings behind a section).
 *  Columns are derived from the returned rows so it adapts to whatever fields come back.
 *  Virtualized (not a plain <table>) — the leaf level now fetches the same full,
 *  un-capped result set the export uses, which can be thousands of rows; rendering
 *  every one as a real DOM row would make the browser crawl, so only the rows
 *  actually in the viewport get mounted, same as DataSets/Views tables already do. */
function RecordsTable({ rows }: { rows: Finding[] }) {
  if (!rows.length) return <div className="loading">No records for this selection.</div>;
  const keys = Object.keys(rows[0]);
  const columns: VCol[] = keys.map((k) => ({ key: k, label: humanize(k), width: 180 }));
  return (
    <div className="records-table">
      <VirtualTable
        columns={columns}
        rows={rows}
        renderCell={(key, row) => formatCell(row[key])}
      />
    </div>
  );
}

/**
 * Interactive chart panel for a user-built chart:
 *  - Chart ⇄ Table toggle (view the aggregated data as a chart or a table).
 *  - Optional drill-down (if the chart has a drill path); clicking a section drills
 *    to the next level, and clicking at the deepest level shows the raw records.
 */
export default function DrilldownChart({
  dashboardKey, widget, baseRows,
}: {
  dashboardKey: string;
  widget: DashboardWidget;
  baseRows: QueryRow[];
}) {
  const spec = widget.config;
  // In Grouping mode the group-by levels ARE the drill hierarchy; otherwise it's the
  // base X dimension plus the configured drill-down path.
  const sequence: string[] = spec.mode === "clause"
    ? (spec.groupBy ?? []).filter(Boolean)
    : [spec.dimension, ...(spec.drilldown ?? [])].filter(Boolean);
  const hasDrill = sequence.length > 1;

  const [drillEnabled, setDrillEnabled] = useState(false);
  const [steps, setSteps] = useState<DrillStep[]>([]);
  const [rows, setRows] = useState<QueryRow[]>(baseRows);
  const [records, setRecords] = useState<{ steps: DrillStep[]; rows: Finding[]; truncated: boolean } | null>(null);
  const [tableView, setTableView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // A level's long tail arrives as one "Other (N more)" bar. It keeps the chart's total
  // honest, but it is often far larger than any single group and then flattens all of
  // them — so it can be taken out of the view without changing the underlying data.
  const [showOther, setShowOther] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleSeries = (n: string) =>
    setHidden((prev) => { const s = new Set(prev); if (s.has(n)) s.delete(n); else s.add(n); return s; });

  const hasOther = rows.some((r) => isRolledUpGroup(r.x));
  const chartRows = useMemo(
    () => (showOther ? rows : rows.filter((r) => !isRolledUpGroup(r.x))),
    [rows, showOther],
  );

  // Series/categories available to the legend for the current (possibly drilled) rows.
  const legendVals = legendNames(widget.widget_type, rows);
  const showLegendCtl = !records && !tableView && (spec.showLegend ?? true) && legendVals.length > 1;

  const atLeaf = steps.length >= sequence.length - 1; // showing the last aggregation level

  // Build headers + rows for exporting the chart's tabular data.
  const exportData = () => {
    const hasSeries = rows.some((r) => r.series != null);
    const valueLabel = humanize(spec.measure) || "Value";
    const xLabel = humanize(spec.dimension) || "Category";
    const seriesLabel =
      (spec.groupBy?.length ? spec.groupBy.map(humanize).join(" / ") : humanize(spec.series)) || "Group";
    if (widget.widget_type === "number") {
      return { headers: [valueLabel], out: rows.map((r) => [r.y] as (string | number | null)[]) };
    }
    if (hasSeries) {
      return { headers: [xLabel, seriesLabel, valueLabel], out: rows.map((r) => [r.x ?? "", r.series ?? "", r.y]) };
    }
    return { headers: [xLabel, valueLabel], out: rows.map((r) => [r.x ?? "", r.y]) };
  };

  // At the leaf drill level the screen shows RAW RECORDS, not the aggregated `rows` —
  // exporting re-fetches the same full matching set the on-screen table already
  // shows (both use full=true now) rather than re-exporting the chart's aggregate data.
  const exportRecordsData = async () => {
    const res = await api.dashboards.records(dashboardKey, widget.id, records!.steps, true);
    if (!res.rows.length) return { headers: [], out: [] as (string | number | null)[][], truncated: false };
    const keys = Object.keys(res.rows[0]);
    return {
      headers: keys.map(humanize),
      out: res.rows.map((r) => keys.map((k) => formatCell(r[k]))),
      truncated: res.truncated,
    };
  };

  const doExport = async (format: "csv" | "excel" | "pdf") => {
    setExporting(format);
    try {
      const { headers, out, truncated } = records ? await exportRecordsData() : { ...exportData(), truncated: false };
      if (truncated) {
        alert(`This selection has more rows than a single export can hold — the first ${out.length.toLocaleString()} are included.`);
      }
      if (format === "csv") {
        downloadText(`${widget.title || "chart"}.csv`, buildCsv(headers, out.map((r) => r.map((c) => String(c ?? "")))));
        return;
      }
      const image = format === "pdf" ? (wrapRef.current?.querySelector("canvas")?.toDataURL("image/png") ?? undefined) : undefined;
      await api.dashboards.exportChart({ format, title: widget.title, caption: spec.caption ?? undefined, headers, rows: out, image });
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => { setRows(baseRows); setSteps([]); setRecords(null); }, [baseRows]);

  const onSectionClick = async (value: string) => {
    if (!drillEnabled || busy) return;
    // The "Other (N more)" bar stands for many values at once — there is no single
    // group beneath it to descend into.
    if (isRolledUpGroup(value)) return;
    setBusy(true);
    try {
      if (!atLeaf) {
        const nextDim = sequence[steps.length];
        const next = [...steps, { dimension: nextDim, value }];
        const res = await api.dashboards.drill(dashboardKey, widget.id, next);
        setSteps(next);
        setRows(res.rows);
      } else {
        // Deepest level → show the underlying records for the full path. Fetches
        // the same uncapped (up to MAX_EXPORT_RECORDS) result set export already
        // used — previously this used the default 200-row preview cap, so what you
        // saw on screen was a small sample of what export actually gave you.
        const leafDim = sequence[steps.length];
        const path = [...steps, { dimension: leafDim, value }];
        const res = await api.dashboards.records(dashboardKey, widget.id, path, true);
        setRecords({ steps: path, rows: res.rows, truncated: res.truncated });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleDrill = () => {
    setDrillEnabled((on) => {
      if (on) { setSteps([]); setRows(baseRows); setRecords(null); }
      return !on;
    });
  };

  const jumpTo = async (level: number) => {
    setRecords(null);
    const next = steps.slice(0, level);
    setBusy(true);
    try {
      if (next.length === 0) { setRows(baseRows); setSteps([]); }
      else {
        const res = await api.dashboards.drill(dashboardKey, widget.id, next);
        setSteps(next);
        setRows(res.rows);
      }
    } finally {
      setBusy(false);
    }
  };

  const crumbs = records ? records.steps : steps;

  return (
    <div ref={wrapRef}>
      <div className="drill-bar">
        <button className={`view-toggle${tableView ? " on" : ""}`} onClick={() => setTableView((v) => !v)}
                title="Switch between chart and table">
          {tableView ? "▦ Table" : "▤ Chart"}
        </button>

        {hasDrill && (
          <button className={`drill-toggle${drillEnabled ? " on" : ""}`} onClick={toggleDrill}>
            🔍 Drill-down {drillEnabled ? "on" : "off"}
          </button>
        )}

        {drillEnabled && crumbs.length > 0 && (
          <span className="crumbs">
            <button onClick={() => jumpTo(0)}>All</button>
            {crumbs.map((s, i) => (
              <span key={i}>
                <span className="sep">›</span>
                <button onClick={() => (i < steps.length ? jumpTo(i + 1) : undefined)}>{s.value}</button>
              </span>
            ))}
          </span>
        )}

        {hasOther && !records && !tableView && (
          <button className={`drill-toggle${showOther ? " on" : ""}`} onClick={() => setShowOther((v) => !v)}
                  title="The rolled-up tail is usually far bigger than any single group, which flattens the rest of the chart.">
            {showOther ? "Other shown" : "Other hidden"}
          </button>
        )}
        {records && <button className="link-btn" onClick={() => setRecords(null)}>← back to chart</button>}
        {drillEnabled && !records && !atLeaf && <span className="hint">click a section to drill in</span>}
        {drillEnabled && !records && atLeaf && <span className="hint">click a section to see records</span>}

        <span className="drill-right">
          {showLegendCtl && <SeriesLegend variant="inline" names={legendVals} hidden={hidden}
                                         onToggle={toggleSeries} palette={paletteOf(spec.theme)} />}
          <span className="chart-export"><ExportMenu onExport={doExport} busy={exporting} /></span>
        </span>
      </div>

      {records ? (
        <>
          {records.truncated && (
            <p className="muted small">
              This selection has more than {records.rows.length.toLocaleString()} records — showing the first {records.rows.length.toLocaleString()}. Export for the complete set.
            </p>
          )}
          <RecordsTable rows={records.rows} />
        </>
      ) : tableView ? (
        <GenericChart type="table" rows={rows} />
      ) : (
        <GenericChart
          type={widget.widget_type}
          rows={chartRows}
          showLegend={spec.showLegend}
          theme={spec.theme}
          hidden={hidden}
          onToggleHidden={toggleSeries}
          clauseLevels={spec.mode === "clause" ? (spec.groupBy ?? []).map(humanize) : undefined}
          onSliceClick={drillEnabled ? onSectionClick : undefined}
          // The field actually being shown right now, not a generic "Group"/"Category"
          // label — sequence[steps.length] is exactly that field for both modes
          // (clause mode's "levels" and a normal dimension+drilldown path are both
          // just an ordered list of fields to descend through). Updates on its own
          // as steps grows with each drill click, since this re-renders every click.
          categoryLabel={humanize(sequence[steps.length]) || "Category"}
          valueLabel={humanize(spec.measure) || "Value"}
        />
      )}
    </div>
  );
}
