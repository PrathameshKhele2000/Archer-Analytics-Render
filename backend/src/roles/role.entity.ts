export interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: string;
  permissions: string[];
}

export interface PermissionRow {
  id: number;
  code: string;
  description: string | null;
}
