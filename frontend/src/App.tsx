import { lazy, Suspense, useEffect, useState } from "react";
import { api, DashboardMeta, ReportMeta, setUnauthorizedHandler } from "./api";
import { consumeSsoHashTokens, hasPermission, SafeUser, tokenStore } from "./auth";
import Login from "./components/Login";

// Loaded on demand: these pull in the heavy chart library (~1 MB). Keeping them out
// of the initial bundle means the login screen and first paint stay small and fast.
const AdminPanel = lazy(() => import("./components/AdminPanel"));
const ArchitecturePage = lazy(() => import("./components/ArchitecturePage"));
const DashboardBuilder = lazy(() => import("./components/DashboardBuilder"));
const DashboardView = lazy(() => import("./components/DashboardView"));
const DataSetsTab = lazy(() => import("./components/DataSetsTab"));
const PersonalizedDashboard = lazy(() => import("./components/PersonalizedDashboard"));
const ReportView = lazy(() => import("./components/ReportView"));

const Loading = () => <div className="loading">loading…</div>;

type Section = "dashboard" | "personal" | "datasets" | "reports" | "admin";

export default function App() {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [ssoError, setSsoError] = useState<string | undefined>();
  const [section, setSection] = useState<Section>("dashboard");
  const [dashboards, setDashboards] = useState<DashboardMeta[]>([]);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [activeDashboard, setActiveDashboard] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [showArch, setShowArch] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    // If we arrived from the SSO callback, tokens are in the URL fragment.
    const sso = consumeSsoHashTokens();
    if (sso && !sso.ok) setSsoError(sso.error);
    if (!tokenStore.getAccess()) {
      setChecked(true);
      return;
    }
    api.auth.me().then(setUser).catch(() => setUser(null)).finally(() => setChecked(true));
  }, []);

  const loadDashboards = () => {
    api.dashboards.list().then((all) => {
      // The main Dashboards tab shows what an admin SHARED with the user (via their
      // roles/groups). A non-admin's own creations belong exclusively to their
      // Personalized Dashboard tab, so they're filtered out here — System Admin keeps
      // seeing everything (that tab is their workspace and they have no personal tab).
      const rows = user && !hasPermission(user, "admin:dashboards:manage")
        ? all.filter((d) => d.owner_user_id !== user.id)
        : all;
      setDashboards(rows);
      setActiveDashboard((cur) => (cur && rows.some((r) => r.key === cur) ? cur : rows[0]?.key ?? null));
    }).catch(console.error);
  };

  useEffect(() => {
    if (!user) return;
    if (hasPermission(user, "dashboard:read")) loadDashboards();
    if (hasPermission(user, "report:read")) {
      api.reports.list().then((rows) => {
        setReports(rows);
        setActiveReport((cur) => cur ?? rows[0]?.key ?? null);
      }).catch(console.error);
    }
  }, [user]);

  if (!checked) return <div className="loading">loading…</div>;
  if (showArch) {
    return (
      <Suspense fallback={<Loading />}>
        <ArchitecturePage onBack={() => setShowArch(false)} authed={!!user} />
      </Suspense>
    );
  }
  if (!user) return <Login onSuccess={() => api.auth.me().then(setUser)} ssoError={ssoError} onShowArchitecture={() => setShowArch(true)} />;

  const canAdmin = ["admin:users:manage", "admin:roles:manage", "sync:read", "audit:read"].some((p) =>
    hasPermission(user, p),
  );
  // System Admin already has the full Dashboards tab over every dataset; the
  // Personalized Dashboard (charts built on the user's accessible Views) is for
  // everyone else who can build dashboards.
  const isSystemAdmin = user.roles.includes("System Admin");
  const canPersonalize = !isSystemAdmin && hasPermission(user, "dashboard:create") && hasPermission(user, "report:read");
  // The main Dashboards tab builds charts on raw DATASETS, which only System Admin may
  // do. Everyone else builds on their accessible Views in the Personalized Dashboard
  // tab, so the dataset builder here is admin-only.
  const canManageDashboards = hasPermission(user, "admin:dashboards:manage");
  const canCreateDashboards = canManageDashboards;
  const currentDashboard = dashboards.find((d) => d.key === activeDashboard);
  const ownsCurrent = !!currentDashboard && currentDashboard.owner_user_id === user.id;
  const canEditCurrent = canManageDashboards;

  const logout = () => {
    tokenStore.clear();
    setUser(null);
  };

  const deleteCurrent = async () => {
    if (!currentDashboard || !confirm(`Delete dashboard "${currentDashboard.name}"?`)) return;
    await api.dashboards.remove(currentDashboard.key);
    setActiveDashboard(null);
    loadDashboards();
  };

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Archer Analytics Platform</h1>
        <nav className="tabs">
          {hasPermission(user, "dashboard:read") && (
            <button className={section === "dashboard" ? "active" : ""} onClick={() => setSection("dashboard")}>
              Dashboards
            </button>
          )}
          {canPersonalize && (
            <button className={section === "personal" ? "active" : ""} onClick={() => setSection("personal")}>
              Personalized Dashboard
            </button>
          )}
          {isSystemAdmin && (
            <button className={section === "datasets" ? "active" : ""} onClick={() => setSection("datasets")}>
              DataSets
            </button>
          )}
          {hasPermission(user, "report:read") && (
            <button className={section === "reports" ? "active" : ""} onClick={() => setSection("reports")}>
              Views
            </button>
          )}
          {canAdmin && (
            <button className={section === "admin" ? "active" : ""} onClick={() => setSection("admin")}>
              Admin Panel
            </button>
          )}
          {/* Raw dataset browsing and the architecture page are for System Admin only;
              other users work through their Views and Personalized Dashboard. */}
          {isSystemAdmin && <button onClick={() => setShowArch(true)}>Architecture</button>}
        </nav>
        <div className="sync">
          <span>{user.full_name} · {user.roles.join(", ")}</span>
          <button onClick={logout}>Sign out</button>
        </div>
      </header>

      <Suspense fallback={<Loading />}>
      {section === "dashboard" && (
        building ? (
          <DashboardBuilder
            onSaved={(key) => { setBuilding(false); loadDashboards(); setActiveDashboard(key); }}
            onCancel={() => setBuilding(false)}
          />
        ) : (
          <>
            <div className="dash-toolbar">
              {dashboards.length > 0 && (
                <select value={activeDashboard ?? ""} onChange={(e) => setActiveDashboard(e.target.value)}>
                  {dashboards.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.name}{d.owner_user_id === user.id ? " (mine)" : ""}
                    </option>
                  ))}
                </select>
              )}
              <div className="dash-toolbar-right">
                {canCreateDashboards && (
                  <button onClick={() => setBuilding(true)}>+ New dashboard</button>
                )}
                {ownsCurrent && <button onClick={deleteCurrent}>Delete dashboard</button>}
              </div>
            </div>
            {activeDashboard ? (
              <DashboardView key={activeDashboard} dashboardKey={activeDashboard} canEdit={canEditCurrent} />
            ) : (
              <div className="loading">No dashboards yet. {canCreateDashboards ? "Create one to get started." : ""}</div>
            )}
          </>
        )
      )}

      {section === "personal" && canPersonalize && <PersonalizedDashboard user={user} />}

      {section === "datasets" && isSystemAdmin && <DataSetsTab />}

      {section === "reports" && (
        <>
          {reports.length > 1 && (
            <div className="dash-toolbar">
              <select value={activeReport ?? ""} onChange={(e) => setActiveReport(e.target.value)}>
                {reports.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
              </select>
            </div>
          )}
          {activeReport ? <ReportView reportKey={activeReport} /> : <div className="loading">No reports available.</div>}
        </>
      )}

      {section === "admin" && <AdminPanel permissions={user.permissions} currentUserId={user.id} />}
      </Suspense>
    </div>
  );
}
