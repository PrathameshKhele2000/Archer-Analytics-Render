export interface DashboardRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  owner_user_id: number | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardWidgetRow {
  id: number;
  dashboard_id: number;
  key: string;
  title: string;
  widget_type: string;
  data_source: string;
  sort_order: number;
  is_active: boolean;
  config: Record<string, unknown>;
}

export interface DashboardAccessRow {
  id: number;
  dashboard_id: number;
  role_id: number | null;
  user_id: number | null;
}

/**
 * Catalog of chart building blocks a user can drop onto a dashboard. Each entry
 * binds a vetted SQL query (WIDGET_DATA_SOURCES) to the chart type that renders it,
 * so the builder offers a safe, fixed palette — no user-authored SQL.
 */
export interface DataSourceCatalogEntry {
  key: string; // == data_source key
  label: string;
  widgetType: string; // 'kpi' | 'donut' | 'bar' | 'line' | 'stacked_bar'
}

export const DATA_SOURCE_CATALOG: DataSourceCatalogEntry[] = [
  { key: "mv_kpi_summary", label: "Key metrics (KPI cards)", widgetType: "kpi" },
  { key: "mv_by_severity", label: "Open findings by severity", widgetType: "donut" },
  { key: "mv_by_business_unit", label: "Open findings by business unit", widgetType: "bar" },
  { key: "mv_trend_monthly", label: "Created vs closed (last 24 months)", widgetType: "line" },
  { key: "mv_aging_buckets", label: "Aging of open findings", widgetType: "stacked_bar" },
];

/** Widgets with this data_source render from a user-composed chart spec stored in `config`. */
export const QUERY_BUILDER_SOURCE = "query_builder";

/** Registered widget data queries. Admins pick a data_source key; the SQL itself is fixed and vetted. */
export const WIDGET_DATA_SOURCES: Record<string, string> = {
  mv_kpi_summary: "SELECT * FROM mv_kpi_summary",
  mv_by_severity:
    "SELECT severity_name, total, open_count FROM mv_by_severity ORDER BY severity_rank DESC",
  mv_by_business_unit:
    "SELECT bu_name, open_count, closed_count, avg_risk_score FROM mv_by_business_unit ORDER BY open_count DESC",
  mv_trend_monthly: `
    SELECT COALESCE(c.month, cl.month)::text AS month,
           COALESCE(c.created, 0) AS created,
           COALESCE(cl.closed, 0) AS closed
    FROM mv_trend_monthly c
    FULL OUTER JOIN mv_closed_monthly cl USING (month)
    ORDER BY month`,
  mv_aging_buckets:
    "SELECT severity_name, d0_30, d31_90, d91_180, d180_plus FROM mv_aging_buckets ORDER BY severity_rank DESC",
};
