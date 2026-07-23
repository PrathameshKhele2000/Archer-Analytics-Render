import { useCallback, useEffect, useState } from "react";
import { api, ChartSpec, DashboardWithData } from "../api";
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

export default function DashboardView({ dashboardKey, canEdit, viewSources }: { dashboardKey: string; canEdit?: boolean; viewSources?: { key: string; name: string }[] }) {
  const [payload, setPayload] = useState<DashboardWithData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | { widgetId: number; title: string; spec: ChartSpec }>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.dashboards.get(dashboardKey).then(setPayload).catch((e) => setError(String(e.message ?? e)));
  }, [dashboardKey]);

  useEffect(() => {
    setAdding(false);
    setEditing(null);
    load();
    // No auto-poll: data changes only on sync, and re-fetching would reset any
    // in-progress chart interaction (drill level, records view).
  }, [load]);

  if (error) return <div className="loading">Could not load dashboard: {error}</div>;
  if (!payload) return <div className="loading">loading dashboard…</div>;

  const { widgets, data } = payload;

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
      {canEdit && (
        <div className="dash-toolbar">
          <button onClick={() => setAdding(true)}>+ Add chart</button>
        </div>
      )}

      {kpiWidgets.length > 0 && (
        <div className="kpis">
          {kpiWidgets.map((w) => {
            const spec = (w.config ?? {}) as ChartSpec;
            return (
              <div className="kpi" key={w.id}>
                <div className="label">{spec.caption || w.title}</div>
                <div className="value">{fmtKpi(data[w.key]?.[0]?.y)}</div>
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
                {isBuilt && w.widget_type === "table" ? (
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
}
