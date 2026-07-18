import { useState } from "react";
import { api, DashboardWidget, RecordRow } from "../api";
import { buildCsv, downloadText } from "../csv";
import { formatCell, RecCol } from "../recordColumns";
import ExportMenu from "./ExportMenu";

/** Presentational records table: fixed columns + rows, horizontally scrollable. */
export function RecordsTableView({ cols, rows }: { cols: RecCol[]; rows: RecordRow[] }) {
  if (!rows.length) return <div className="loading">No records match this filter.</div>;
  return (
    <div className="records-table">
      <table className="findings">
        <thead>
          <tr>{cols.map((c) => <th key={c.key} className={c.numeric ? "num" : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key} className={c.numeric ? "num" : undefined}>{formatCell(r[c.key], c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const humanize = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Dashboard widget for a Table (records list) chart: filtered records + export.
 * Columns come from the chart's own selection (falling back to whatever the query
 * returned), so this renders any dataset — not just findings.
 */
export default function RecordsChart({ widget, rows }: { widget: DashboardWidget; rows: RecordRow[] }) {
  const keys: string[] = widget.config.tableColumns?.length
    ? widget.config.tableColumns
    : Object.keys(rows[0] ?? {});
  const cols: RecCol[] = keys.map((k) => ({
    key: k,
    label: humanize(k),
    numeric: typeof rows[0]?.[k] === "number",
  }));
  const [exporting, setExporting] = useState<string | null>(null);

  const doExport = async (format: "csv" | "excel" | "pdf") => {
    const headers = cols.map((c) => c.label);
    const out = rows.map((r) => cols.map((c) => (r[c.key] ?? "") as string | number | null));
    if (format === "csv") {
      downloadText(`${widget.title || "records"}.csv`, buildCsv(headers, out.map((r) => r.map((c) => String(c ?? "")))));
      return;
    }
    setExporting(format);
    try {
      await api.dashboards.exportChart({ format, title: widget.title, caption: widget.config.caption ?? undefined, headers, rows: out });
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div>
      <div className="drill-bar">
        <span className="records-count">{rows.length.toLocaleString()} record{rows.length === 1 ? "" : "s"}</span>
        <span className="chart-export"><ExportMenu onExport={doExport} busy={exporting} /></span>
      </div>
      <RecordsTableView cols={cols} rows={rows} />
    </div>
  );
}
