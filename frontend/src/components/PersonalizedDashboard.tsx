import { lazy, Suspense, useEffect, useState } from "react";
import { api, DashboardMeta, ReportMeta } from "../api";
import { SafeUser } from "../auth";

const DashboardView = lazy(() => import("./DashboardView"));
const DashboardBuilder = lazy(() => import("./DashboardBuilder"));

const Loading = () => <div className="loading">loading…</div>;

/**
 * Personalized Dashboard: a per-user space where the user builds charts on the VIEWS
 * they can access (not raw datasets). Each chart reads through a view and is scoped to
 * it, so the user can only ever chart data the view exposes. Shown to every user except
 * System Admin (who already has the full Dashboards tab over every dataset).
 */
export default function PersonalizedDashboard({ user }: { user: SafeUser }) {
  const [views, setViews] = useState<ReportMeta[]>([]);
  const [dashboards, setDashboards] = useState<DashboardMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadDashboards = () =>
    api.dashboards.list().then((rows) => {
      // Only the user's own dashboards belong in their personal space.
      const mine = rows.filter((d) => d.owner_user_id === user.id);
      setDashboards(mine);
      setActive((cur) => (cur && mine.some((d) => d.key === cur) ? cur : mine[0]?.key ?? null));
    }).catch(console.error);

  useEffect(() => {
    Promise.all([
      api.reports.list().then(setViews).catch(() => setViews([])),
      loadDashboards(),
    ]).finally(() => setLoaded(true));
  }, []);

  const viewSources = views.map((v) => ({ key: v.key, name: v.name }));
  const current = dashboards.find((d) => d.key === active) ?? null;

  const deleteCurrent = async () => {
    if (!current || !confirm(`Delete dashboard "${current.name}"?`)) return;
    await api.dashboards.remove(current.key);
    setActive(null);
    loadDashboards();
  };

  if (!loaded) return <Loading />;

  if (!viewSources.length) {
    return (
      <div className="loading">
        You don't have access to any Views yet. Ask an administrator to grant your role access to a view
        (Admin Panel → Access Control), then you can build charts on it here.
      </div>
    );
  }

  if (building) {
    return (
      <Suspense fallback={<Loading />}>
        <DashboardBuilder
          onSaved={(key) => { setBuilding(false); loadDashboards().then(() => setActive(key)); }}
          onCancel={() => setBuilding(false)}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<Loading />}>
      <div className="dash-toolbar">
        {dashboards.length > 0 && (
          <select value={active ?? ""} onChange={(e) => setActive(e.target.value)}>
            {dashboards.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
          </select>
        )}
        <div className="dash-toolbar-right">
          <button onClick={() => setBuilding(true)}>+ New dashboard</button>
          {current && <button onClick={deleteCurrent}>Delete dashboard</button>}
        </div>
      </div>

      <p className="muted small" style={{ padding: "0 4px 8px" }}>
        Build charts on the <b>Views</b> you can access. Each chart is scoped to its view — it only ever shows
        the rows that view exposes.
      </p>

      {active ? (
        <DashboardView key={active} dashboardKey={active} canEdit viewSources={viewSources} />
      ) : (
        <div className="loading">No dashboards yet. Click “+ New dashboard” to start.</div>
      )}
    </Suspense>
  );
}
