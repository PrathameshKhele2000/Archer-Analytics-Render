import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { api, ChartSpec, DashboardShell } from "../api";
import { AgingStack, BusinessUnitBars, MonthlyTrend, SeverityDonut } from "./Charts";
import ChartEditor from "./ChartEditor";
import DrilldownChart from "./DrilldownChart";

/**
 * Shared empty array for widgets with no data yet. `?? []` built a NEW array on every
 * render, which looked like fresh data to the child — resetting an in-progress drill
 * back to the base level.
 */
const NO_ROWS: any[] = [];
import RecordsChart from "./RecordsChart";

/** Legacy fixed widgets (older seeded dashboards) keep their bespoke components. */
function LegacyChart({ type, rows }: { type: string; rows: any[] }) {
  switch (type) {
    case "donut": return <SeverityDonut data={rows} />;
    case "bar": return <BusinessUnitBars data={rows} />;
    case "line": return <MonthlyTrend data={rows} />;
    case "stacked_bar": return <AgingStack data={rows} />;
    default: return <div className="loading">Unsupported widget: {type}</div>;
  }
}

const fmtKpi = (v: unknown) =>
  v == null ? "—" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(v);

/** Lets the parent toolbar's own "+ Add chart" button (sitting beside the dashboard
 *  picker) open this dashboard's chart editor, without lifting all of DashboardView's
 *  add/edit state up into every caller. */
export interface DashboardViewHandle {
  openAddChart: () => void;
}

export default forwardRef<DashboardViewHandle, { dashboardKey: string; canEdit?: boolean; viewSources?: { key: string; name: string }[] }>(
  function DashboardView({ dashboardKey, canEdit, viewSources }, ref) {
  const [shell, setShell] = useState<DashboardShell | null>(null);
  const [data, setData] = useState<Record<string, any[]>>({});
  // Widget ids whose OWN data request hasn't resolved yet. The shell (titles, panel
  // grid, captions) renders as soon as getShell() returns; each widget then fetches its
  // own data independently, so one heavy chart's query time is contained to that one
  // panel instead of blanking the whole dashboard until the slowest widget finishes.
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | { widgetId: number; title: string; spec: ChartSpec }>(null);
  const [adding, setAdding] = useState(false);
  useImperativeHandle(ref, () => ({ openAddChart: () => setAdding(true) }), []);

  const load = useCallback(() => {
    setError(null);
    api.dashboards.getShell(dashboardKey).then((s) => {
      setShell(s);
      setData({});
      setPending(new Set(s.widgets.map((w) => w.id)));
      // Fired off in parallel, not awaited as a batch — each panel updates the moment
      // ITS OWN request lands, rather than everything waiting for Promise.all to settle.
      s.widgets.forEach((w) => {
        api.dashboards.getWidgetData(dashboardKey, w.id)
          .then((rows) => setData((d) => ({ ...d, [w.key]: rows })))
          .catch((e) => { console.error(e); setData((d) => ({ ...d, [w.key]: [] })); })
          .finally(() => setPending((p) => { if (!p.has(w.id)) return p; const n = new Set(p); n.delete(w.id); return n; }));
      });
    }).catch((e) => setError(String(e.message ?? e)));
  }, [dashboardKey]);

  useEffect(() => {
    setAdding(false);
    setEditing(null);
    load();
    // No auto-poll: data changes only on sync, and re-fetching would reset any
    // in-progress chart interaction (drill level, records view).
  }, [load]);

  if (error) return <div className="loading">Could not load dashboard: {error}</div>;
  if (!shell) return <div className="loading">loading dashboard…</div>;

  const { widgets } = shell;

  const removeChart = async (widgetId: number) => {
    if (!confirm("Remove this chart?")) return;
    await api.dashboards.removeChart(dashboardKey, widgetId);
    load();
  };

  if (adding || editing) {
    return (
      <ChartEditor
        dashboardKey={dashboardKey}
        existing={editing ?? undefined}
        viewSources={viewSources}
        onSaved={() => { setAdding(false); setEditing(null); load(); }}
        onCancel={() => { setAdding(false); setEditing(null); }}
      />
    );
  }

  // 'number' charts render as compact KPI cards at the top; everything else fills the grid.
  const isKpi = (w: (typeof widgets)[number]) => w.data_source === "query_builder" && w.widget_type === "number";
  const kpiWidgets = widgets.filter(isKpi);
  const gridWidgets = widgets.filter((w) => w.widget_type !== "kpi" && !isKpi(w));

  return (
    <>
      {kpiWidgets.length > 0 && (
        <div className="kpis">
          {kpiWidgets.map((w) => {
            const spec = (w.config ?? {}) as ChartSpec;
            return (
              <div className="kpi" key={w.id}>
                <div className="label">{spec.caption || w.title}</div>
                <div className="value">{pending.has(w.id) ? "…" : fmtKpi(data[w.key]?.[0]?.y)}</div>
                {canEdit && (
                  <div className="kpi-actions">
                    <button title="Edit" onClick={() => setEditing({ widgetId: w.id, title: w.title, spec })}>✎</button>
                    <button title="Remove" onClick={() => removeChart(w.id)}>✕</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {gridWidgets.length > 0 && (
        <div className="grid2">
          {gridWidgets.map((w) => {
            const isBuilt = w.data_source === "query_builder";
            const spec = (w.config ?? {}) as ChartSpec;
            return (
              <section className="panel" key={w.id}>
                <div className="panel-head">
                  <div>
                    <h2>{w.title}</h2>
                    {spec.caption && <div className="panel-caption">{spec.caption.split(" · drill:")[0]}</div>}
                  </div>
                  {canEdit && isBuilt && (
                    <div className="panel-actions">
                      <button onClick={() => setEditing({ widgetId: w.id, title: w.title, spec })}>Edit</button>
                      <button onClick={() => removeChart(w.id)}>✕</button>
                    </div>
                  )}
                </div>
                {pending.has(w.id) ? (
                  <div className="loading">loading chart…</div>
                ) : isBuilt && w.widget_type === "table" ? (
                  <RecordsChart widget={w} rows={data[w.key] ?? NO_ROWS} />
                ) : isBuilt ? (
                  <DrilldownChart dashboardKey={dashboardKey} widget={w} baseRows={data[w.key] ?? NO_ROWS} />
                ) : (
                  <LegacyChart type={w.widget_type} rows={data[w.key] ?? NO_ROWS} />
                )}
              </section>
            );
          })}
        </div>
      )}

      {widgets.length === 0 && (
        <div className="loading">
          This dashboard has no charts yet.{canEdit ? " Click “+ Add chart” to build one." : ""}
        </div>
      )}
    </>
  );
});
