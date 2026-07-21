export interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: string;
  permissions: string[];
  /** Views (reports) this role has read access to. */
  view_ids: number[];
  /** Dashboards this role has read access to. */
  dashboard_ids: number[];
}

export interface PermissionRow {
  id: number;
  code: string;
  description: string | null;
}
