export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  full_name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  roles: string[];
  permissions: string[];
}

export type SafeUser = Omit<UserRow, "password_hash">;

export function toSafeUser(u: UserRow): SafeUser {
  const { password_hash, ...safe } = u;
  return safe;
}
