import { useEffect, useRef, useState } from "react";
import { api, DashboardWidget, DrillStep, Finding, QueryRow } from "../api";
import { buildCsv, downloadText } from "../csv";
import { formatCell } from "../recordColumns";
import ExportMenu from "./ExportMenu";
import GenericChart, { legendNames, SeriesLegend } from "./GenericChart";

const humanize = (k?: string | null) => (k ? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");

/** Records table shown at the deepest drill level (the raw findings behind a section).
 *  Columns are derived from the returned rows so it adapts to whatever fields come back. */
function RecordsTable({ rows }: { rows: Finding[] }) {
  if (!rows.length) return <div className="loading">No records for this selection.</div>;
  const keys = Object.keys(rows[0]);
  return (
    <div className="records-table">
      <table className="findings">
        <thead>
          <tr>{keys.map((k) => <th key={k}>{humanize(k)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{keys.map((k) => <td key={k}>{formatCell(r[k])}</td>)}</tr>
          ))}
        </tbody>
      </table>
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
  const [records, setRecords] = useState<{ steps: DrillStep[]; rows: Finding[] } | null>(null);
  const [tableView, setTableView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleSeries = (n: string) =>
    setHidden((prev) => { const s = new Set(prev); if (s.has(n)) s.delete(n); else s.add(n); return s; });

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

  const doExport = async (format: "csv" | "excel" | "pdf") => {
    const { headers, out } = exportData();
    if (format === "csv") {
      downloadText(`${widget.title || "chart"}.csv`, buildCsv(headers, out.map((r) => r.map((c) => String(c ?? "")))));
      return;
    }
    setExporting(format);
    try {
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
    setBusy(true);
    try {
      if (!atLeaf) {
        const nextDim = sequence[steps.length];
        const next = [...steps, { dimension: nextDim, value }];
        const res = await api.dashboards.drill(dashboardKey, widget.id, next);
        setSteps(next);
        setRows(res.rows);
      } else {
        // Deepest level → show the underlying records for the full path.
        const leafDim = sequence[steps.length];
        const full = [...steps, { dimension: leafDim, value }];
        const res = await api.dashboards.records(dashboardKey, widget.id, full);
        setRecords({ steps: full, rows: res.rows });
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

        {records && <button className="link-btn" onClick={() => setRecords(null)}>← back to chart</button>}
        {drillEnabled && !records && !atLeaf && <span className="hint">click a section to drill in</span>}
        {drillEnabled && !records && atLeaf && <span className="hint">click a section to see records</span>}

        <span className="drill-right">
          {showLegendCtl && <SeriesLegend variant="inline" names={legendVals} hidden={hidden} onToggle={toggleSeries} />}
          <span className="chart-export"><ExportMenu onExport={doExport} busy={exporting} /></span>
        </span>
      </div>

      {records ? (
        <RecordsTable rows={records.rows} />
      ) : tableView ? (
        <GenericChart type="table" rows={rows} />
      ) : (
        <GenericChart
          type={widget.widget_type}
          rows={rows}
          showLegend={spec.showLegend}
          hidden={hidden}
          clauseLevels={spec.mode === "clause" ? (spec.groupBy ?? []).map(humanize) : undefined}
          onSliceClick={drillEnabled ? onSectionClick : undefined}
        />
      )}
    </div>
  );
}
