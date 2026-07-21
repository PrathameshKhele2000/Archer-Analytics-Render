export interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** Roles this group grants to every member. */
  role_ids: number[];
  role_names: string[];
  /** Users in the group. */
  user_ids: number[];
  member_count: number;
}
