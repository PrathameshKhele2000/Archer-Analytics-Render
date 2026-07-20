import { SafeUser, tokenStore } from "./auth";

/**
 * Base URL for all API calls. Empty for local dev (Vite proxy) and Docker (nginx
 * proxy), where /api is same-origin. On hosts where the frontend and backend are
 * SEPARATE origins (e.g. Render: static site + web service), set VITE_API_BASE at
 * build time to the backend's absolute URL, e.g. https://archer-analytics-render.onrender.com
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
const apiUrl = (path: string) => API_BASE + path;

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) return false;
  try {
    const res = await fetch(apiUrl("/api/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    tokenStore.set(body.accessToken, body.refreshToken);
    return true;
  } catch {
    return false;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = tokenStore.getAccess();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(await authHeaders()), ...init.headers },
  });
  if (res.status === 401 && !retried) {
    if (!refreshInFlight) refreshInFlight = doRefresh().finally(() => (refreshInFlight = null));
    const ok = await refreshInFlight;
    if (ok) return request<T>(path, init, true);
    tokenStore.clear();
    onUnauthorized?.();
    throw new Error("Session expired");
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  // Tolerate empty bodies (e.g. a 200 from a void DELETE) instead of failing on JSON.parse.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

async function saveBlob(res: Response, fallback: string) {
  if (!res.ok) throw new Error(`download -> ${res.status}`);
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const filename = match ? match[1].trim() : fallback;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function download(path: string): Promise<void> {
  const res = await fetch(apiUrl(path), { headers: await authHeaders() });
  await saveBlob(res, "export");
}

async function downloadPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  await saveBlob(res, "export");
}

// ---- Domain types ----

export interface Summary {
  total_findings: number; open_findings: number; overdue_findings: number;
  open_critical: number; avg_open_risk_score: number; avg_days_to_close: number;
}
export interface SevRow { severity_name: string; total: number; open_count: number; }
export interface BuRow { bu_name: string; open_count: number; closed_count: number; avg_risk_score: number; }
export interface TrendRow { month: string; created: number; closed: number; }
export interface AgingRow { severity_name: string; d0_30: number; d31_90: number; d91_180: number; d180_plus: number; }
/** A findings record: shape follows the Archer application fields (kept open-ended). */
export type Finding = Record<string, any>;
export interface Page { total: number; totalCapped?: boolean; totalEstimated?: boolean; page: number; size: number; rows: Finding[]; }
export interface FilterOptions { severities: string[]; statuses: string[]; business_units: string[]; }
export interface SyncState {
  module_alias: string; last_status: string; last_run_at: string | null; rows_synced: number;
  error_detail: string | null;
}
export interface SyncHistoryRow {
  id: number; module_alias: string; run_type: string; status: string; attempt: number;
  rows_synced: number; error_detail: string | null; started_at: string; finished_at: string | null;
  duration_ms: number | null;
}

export interface DashboardMeta {
  id: number; key: string; name: string; description: string | null;
  owner_user_id: number | null; is_active: boolean; sort_order: number;
}
export interface DataSource { key: string; label: string; widgetType: string; }

export interface CatalogItem { key: string; label: string; }
export interface ChartTypeDef { key: string; label: string; needsDimension: boolean; supportsSeries: boolean; }
// ---- Datasets: one pipe = one source table -> one target table ----
export const DATA_TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "integer", label: "Whole number" },
  { value: "number", label: "Decimal number" },
  { value: "date", label: "Date" },
  { value: "timestamp", label: "Date & time" },
  { value: "boolean", label: "Yes / No" },
  { value: "json", label: "List (multi-value)" },
];
export interface Dataset {
  id: number;
  key: string;
  name: string;
  description: string | null;
  source_table: string | null;
  target_table: string;
  key_column: string;
  watermark_column: string | null;
  is_active: boolean;
  is_protected: boolean;
  field_count: number;
  table_exists: boolean;
}
export interface DatasetFieldDef {
  key?: string;
  label: string;
  data_type: string;
  is_dimension?: boolean;
  is_measurable?: boolean;
  is_searchable?: boolean;
}
export interface CreateDatasetBody {
  name: string;
  description?: string;
  sourceTable?: string;
  keyColumn?: string;
  watermarkColumn?: string;
  fields: DatasetFieldDef[];
}

// ---- Record Views ("folders" in Records): a saved rule, not a container ----
export interface RecordView {
  id: number;
  key: string;
  name: string;
  description: string | null;
  dataset_key: string;
  base_conditions: FilterCondition[];
  base_logic: string | null;
  is_active: boolean;
  sort_order: number;
  columns: string[];
  role_ids: number[];
}
export interface SaveViewBody {
  name: string;
  datasetKey?: string;
  description?: string;
  baseConditions?: FilterCondition[];
  baseLogic?: string | null;
  columns?: { key: string; label: string }[];
  roleIds?: number[];
  isActive?: boolean;
  sortOrder?: number;
}

// ---- Archer -> reporting field mapping (Admin Panel) ----
export const TRANSFORM_OPTIONS = [
  { value: "direct", label: "Direct (as-is)" },
  { value: "values_list", label: "Values list → text" },
  { value: "users_list", label: "Users/Groups → list" },
  { value: "xref_display", label: "Cross-reference → names" },
  { value: "xref_ids", label: "Cross-reference → IDs" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
  { value: "json", label: "Raw JSON" },
];
export interface MappingRow {
  id: number;
  source: string;
  archer_field_id: number | null;
  archer_field_name: string;
  archer_field_type: string | null;
  target_column: string | null;
  transform: string;
  is_enabled: boolean;
  suggestion: { column: string; score: number } | null;
}
export interface MappingPayload {
  source: string;
  targets: { column: string; dataType: string }[];
  rows: MappingRow[];
  mapped: number;
  unmapped: number;
}
export interface MappingSaveRow {
  id: number;
  target_column: string | null;
  transform?: string;
  is_enabled?: boolean;
}

export interface DashboardSchema {
  /** The dataset this catalog describes, plus the datasets a chart can be built on. */
  dataset: { key: string; name: string };
  datasets: { key: string; name: string }[];
  dimensions: CatalogItem[];
  measures: CatalogItem[];
  chartTypes: ChartTypeDef[];
  filters: CatalogItem[];
  filterFields: FilterFieldDef[];
  operators: Record<FieldType, OperatorDef[]>;
  recordColumns: { key: string; label: string; numeric?: boolean }[];
}
export type RecordRow = Record<string, string | number | null>;
export interface ChartSpec {
  /** Which dataset the chart reads; omitted = the findings dataset. */
  dataset?: string | null;
  chartType: string;
  mode?: "aggregate" | "compare";
  dimension?: string | null;
  series?: string | null;
  groupBy?: string[] | null;
  compareField?: string | null;
  measure: string;
  conditions?: FilterCondition[] | null;
  logic?: string | null;
  filters?: Record<string, string> | null;
  openOnly?: boolean;
  limit?: number | null;
  showLegend?: boolean;
  drilldown?: string[] | null;
  caption?: string | null;
  tableColumns?: string[] | null;
}
export interface QueryRow { x?: string; series?: string; y: number; }
export interface DrillStep { dimension: string; value: string; }
export interface DrillResult { rows: QueryRow[]; dimension: string | null; atLeaf: boolean; }
export interface DashboardWidget {
  id: number; dashboard_id: number; key: string; title: string;
  widget_type: string; data_source: string; sort_order: number; is_active: boolean;
  config: Record<string, any>;
}
export interface DashboardWithData {
  dashboard: DashboardMeta;
  widgets: DashboardWidget[];
  data: Record<string, any[]>;
}

export interface ReportMeta {
  id: number; key: string; name: string; description: string | null;
  data_source: string; is_active: boolean;
}
export interface ReportColumn {
  id: number; key: string; label: string; sortable: boolean;
  is_default_visible: boolean; sort_order: number;
}
export interface ReportFilter {
  id: number; key: string; label: string; filter_type: string;
  source: string | null; sort_order: number;
}
export interface ReportConfig { report: ReportMeta; columns: ReportColumn[]; filters: ReportFilter[]; }

export type FieldType = "text" | "number" | "date" | "datetime" | "time" | "enum" | "boolean";
export interface FilterFieldDef { key: string; label: string; type: FieldType; options?: string[]; }
export interface OperatorDef { op: string; label: string; arity: 0 | 1 | 2 | -1; }
export interface FieldsCatalog { fields: FilterFieldDef[]; operators: Record<FieldType, OperatorDef[]>; }
export interface FilterCondition { field: string; operator: string; value?: string; value2?: string; values?: string[]; }

export interface Role { id: number; name: string; description: string | null; is_system: boolean; permissions: string[]; }
export interface Permission { id: number; code: string; description: string | null; }
export interface AuditEntry {
  id: number; user_id: number | null; user_email: string | null; action: string;
  entity_type: string | null; entity_id: string | null; method: string | null;
  path: string | null; status_code: number | null; created_at: string;
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      post<{ accessToken: string; refreshToken: string; user: SafeUser }>("/api/auth/login", { email, password }),
    me: () => get<SafeUser>("/api/auth/me"),
    ssoConfig: () => get<{ enabled: boolean }>("/api/auth/sso/config"),
    ssoLoginUrl: apiUrl("/api/auth/sso/login"),
  },

  dashboards: {
    list: () => get<DashboardMeta[]>("/api/dashboards"),
    get: (key: string) => get<DashboardWithData>(`/api/dashboards/${key}`),
    schema: (dataset?: string) =>
      get<DashboardSchema>(`/api/dashboards/schema${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ""}`),
    preview: (spec: ChartSpec) =>
      post<{ rows: any[]; columns?: { key: string; label: string; numeric?: boolean }[] }>(
        "/api/dashboards/query-preview", spec,
      ),
    create: (body: { name: string; description?: string }) =>
      post<DashboardMeta>("/api/dashboards", body),
    update: (key: string, body: { name?: string; description?: string }) =>
      patch<DashboardMeta>(`/api/dashboards/${key}`, body),
    remove: (key: string) => del<void>(`/api/dashboards/${key}`),
    share: (key: string, body: { roleId?: number; userId?: number }) =>
      post<unknown>(`/api/dashboards/${key}/share`, body),
    addChart: (key: string, body: { title: string; spec: ChartSpec }) =>
      post<DashboardWidget>(`/api/dashboards/${key}/charts`, body),
    updateChart: (key: string, widgetId: number, body: { title?: string; spec?: ChartSpec }) =>
      patch<DashboardWidget[]>(`/api/dashboards/${key}/charts/${widgetId}`, body),
    removeChart: (key: string, widgetId: number) =>
      del<void>(`/api/dashboards/${key}/charts/${widgetId}`),
    drill: (key: string, widgetId: number, steps: DrillStep[]) =>
      post<DrillResult>(`/api/dashboards/${key}/charts/${widgetId}/drill`, { steps }),
    records: (key: string, widgetId: number, steps: DrillStep[]) =>
      post<{ rows: Finding[] }>(`/api/dashboards/${key}/charts/${widgetId}/records`, { steps }),
    exportChart: (body: {
      format: "pdf" | "excel"; title: string; caption?: string;
      headers: string[]; rows: (string | number | null)[][]; image?: string;
    }) => downloadPost("/api/dashboards/charts/export", body),
  },

  reports: {
    list: () => get<ReportMeta[]>("/api/reports"),
    config: (key: string) => get<ReportConfig>(`/api/reports/${key}/config`),
    filters: (key: string) => get<FilterOptions>(`/api/reports/${key}/filters`),
    fields: (key: string) => get<FieldsCatalog>(`/api/reports/${key}/fields`),
    data: (key: string, q: Record<string, string>) =>
      get<Page>(`/api/reports/${key}/data?${new URLSearchParams(q)}`),
    exportCsv: (key: string, q: Record<string, string>) =>
      download(`/api/reports/${key}/export/csv?${new URLSearchParams(q)}`),
    exportExcel: (key: string, q: Record<string, string>) =>
      download(`/api/reports/${key}/export/excel?${new URLSearchParams(q)}`),
    exportPdf: (key: string, q: Record<string, string>) =>
      download(`/api/reports/${key}/export/pdf?${new URLSearchParams(q)}`),
  },

  sync: {
    status: () => get<SyncState[]>("/api/sync/status"),
    history: (limit = 25) => get<SyncHistoryRow[]>(`/api/sync/history?limit=${limit}`),
    run: (full = false) => post<{ status: string; full: boolean }>(`/api/sync/run?full=${full}`),
  },

  admin: {
    users: {
      list: () => get<SafeUser[]>("/api/admin/users"),
      create: (body: { email: string; password: string; fullName: string; roleIds?: number[] }) =>
        post<SafeUser>("/api/admin/users", body),
      update: (id: number, body: Partial<{ fullName: string; email: string; password: string; isActive: boolean; roleIds: number[] }>) =>
        patch<SafeUser>(`/api/admin/users/${id}`, body),
      remove: (id: number) => del<void>(`/api/admin/users/${id}`),
      import: (users: ImportUserRow[]) => post<ImportSummary>("/api/admin/users/import", { users }),
    },
    roles: {
      list: () => get<Role[]>("/api/admin/roles"),
      permissions: () => get<Permission[]>("/api/admin/roles/permissions"),
      create: (body: { name: string; description?: string; permissionIds?: number[] }) =>
        post<Role>("/api/admin/roles", body),
      setPermissions: (id: number, permissionIds: number[]) =>
        request<Role>(`/api/admin/roles/${id}/permissions`, {
          method: "PUT",
          body: JSON.stringify({ permissionIds }),
        }),
      remove: (id: number) => del<void>(`/api/admin/roles/${id}`),
      import: (roles: ImportRoleRow[]) => post<ImportSummary>("/api/admin/roles/import", { roles }),
    },
    source: {
      ping: () => get<{ ok: boolean; server?: string; error?: string }>("/api/admin/source/ping"),
      tables: () => get<{ name: string; type: string }[]>("/api/admin/source/tables"),
      columns: (table: string) =>
        get<{ name: string; sqlType: string; nullable: boolean; dataType: string }[]>(
          `/api/admin/source/columns?table=${encodeURIComponent(table)}`),
    },
    datasets: {
      list: () => get<Dataset[]>("/api/admin/datasets"),
      fields: (id: number) => get<{ key: string; label: string; data_type: string; is_dimension: boolean; is_measurable: boolean; is_searchable: boolean }[]>(`/api/admin/datasets/${id}/fields`),
      preview: (body: CreateDatasetBody) =>
        post<{ targetTable: string; sql: string }>("/api/admin/datasets/preview", body),
      create: (body: CreateDatasetBody) => post<Dataset>("/api/admin/datasets", body),
      update: (id: number, body: CreateDatasetBody) => patch<Dataset>(`/api/admin/datasets/${id}`, body),
      importRows: (id: number, rows: Record<string, any>[], keyColumn?: string) =>
        post<{ loaded: number }>(`/api/admin/datasets/${id}/import`, { rows, keyColumn }),
      remove: (id: number) => del<void>(`/api/admin/datasets/${id}`),
    },
    views: {
      list: () => get<RecordView[]>("/api/admin/reports/views"),
      datasets: () => get<{ key: string; name: string }[]>("/api/admin/reports/datasets"),
      datasetSchema: (dataset: string) =>
        get<FieldsCatalog & { recordColumns: { key: string; label: string; numeric?: boolean }[] }>(
          `/api/admin/reports/dataset-schema?dataset=${encodeURIComponent(dataset)}`),
      // `capped` = the real total is higher (counting stops past a cap for speed).
      matchCount: (datasetKey: string, conditions: FilterCondition[], logic?: string) =>
        post<{ total: number; capped: boolean }>("/api/admin/reports/match-count", { datasetKey, conditions, logic }),
      create: (body: SaveViewBody) => post<RecordView>("/api/admin/reports/views", body),
      update: (id: number, body: SaveViewBody) =>
        request<RecordView>(`/api/admin/reports/views/${id}`, { method: "PUT", body: JSON.stringify(body) }),
      remove: (id: number) => del<void>(`/api/admin/reports/views/${id}`),
    },
  },

  audit: {
    search: (q: Record<string, string>) =>
      get<{ total: number; rows: AuditEntry[] }>(`/api/audit?${new URLSearchParams(q)}`),
  },

  mapping: {
    list: () => get<MappingPayload>("/api/admin/mapping"),
    autoMap: () => post<{ applied: number; mapped: number; unmapped: number }>("/api/admin/mapping/auto-map", {}),
    save: (rows: MappingSaveRow[]) =>
      request<MappingPayload>("/api/admin/mapping", { method: "PUT", body: JSON.stringify({ rows }) }),
  },
};

export interface ImportUserRow { email: string; fullName: string; password?: string; roles?: string[]; }
export interface ImportRoleRow { name: string; description?: string; permissions?: string[]; }
export interface ImportRowResult {
  row: number; key: string; status: "created" | "updated" | "error"; message?: string; tempPassword?: string;
}
export interface ImportSummary {
  total: number; created: number; updated: number; failed: number; results: ImportRowResult[];
}

export const SEV_COLORS: Record<string, string> = {
  Critical: "#b3382c", High: "#d98e32", Medium: "#5b7da8", Low: "#7a9471",
};
