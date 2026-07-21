import { Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { BaseRepository } from "../common/base.repository";
import { UserRow } from "./user.entity";

/**
 * A user's EFFECTIVE roles: the ones assigned to them directly, plus the ones
 * carried by every group they belong to. UNION (not UNION ALL) so a role held
 * both ways still counts once. Everything downstream — the JWT roles array, the
 * permissions array, dashboard/view access checks — reads through this, so group
 * membership grants access without any other code knowing groups exist.
 */
const EFFECTIVE_ROLE_IDS = `
  SELECT ur.role_id FROM user_roles ur WHERE ur.user_id = u.id
  UNION
  SELECT ugr.role_id
    FROM user_group_member ugm
    JOIN user_group_role ugr ON ugr.group_id = ugm.group_id
   WHERE ugm.user_id = u.id
`;

const ENRICHED_SELECT = `
  SELECT u.*,
    coalesce(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
    coalesce(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
  FROM users u
  LEFT JOIN LATERAL (${EFFECTIVE_ROLE_IDS}) er ON TRUE
  LEFT JOIN roles r ON r.id = er.role_id
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id
`;

@Injectable()
export class UsersRepository extends BaseRepository<UserRow> {
  protected readonly table = "users";

  constructor(db: DbService) {
    super(db);
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.query<UserRow>(
      `${ENRICHED_SELECT} WHERE u.email = $1 GROUP BY u.id`,
      [email],
    );
    return rows[0] ?? null;
  }

  async findByIdEnriched(id: number): Promise<UserRow | null> {
    const { rows } = await this.query<UserRow>(
      `${ENRICHED_SELECT} WHERE u.id = $1 GROUP BY u.id`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listEnriched(): Promise<UserRow[]> {
    const { rows } = await this.query<UserRow>(`${ENRICHED_SELECT} GROUP BY u.id ORDER BY u.email`);
    return rows;
  }

  async create(email: string, passwordHash: string, fullName: string): Promise<UserRow> {
    const { rows } = await this.query<UserRow>(
      `INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING *`,
      [email, passwordHash, fullName],
    );
    return rows[0];
  }

  /** Create an SSO (OIDC) user with no password, assign a default role — all in one transaction. */
  async createSsoUser(email: string, fullName: string, defaultRoleName: string): Promise<UserRow> {
    const id = await this.transaction<number>(async (client) => {
      const ins = await client.query(
        `INSERT INTO users (email, password_hash, full_name, auth_provider)
         VALUES ($1, NULL, $2, 'oidc') RETURNING id`,
        [email, fullName],
      );
      const newId = ins.rows[0].id;
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, r.id FROM roles r WHERE r.name = $2
         ON CONFLICT DO NOTHING`,
        [newId, defaultRoleName],
      );
      return newId;
    });
    return (await this.findByIdEnriched(id))!;
  }

  async updateProfile(id: number, fields: { fullName?: string; email?: string; isActive?: boolean }): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [id];
    if (fields.fullName !== undefined) {
      params.push(fields.fullName);
      sets.push(`full_name=$${params.length}`);
    }
    if (fields.email !== undefined) {
      params.push(fields.email);
      sets.push(`email=$${params.length}`);
    }
    if (fields.isActive !== undefined) {
      params.push(fields.isActive);
      sets.push(`is_active=$${params.length}`);
    }
    if (!sets.length) return;
    await this.query(`UPDATE users SET ${sets.join(", ")}, updated_at=now() WHERE id=$1`, params);
  }

  async delete(id: number): Promise<void> {
    // user_roles / owned dashboards cascade via ON DELETE CASCADE.
    await this.query(`DELETE FROM users WHERE id=$1`, [id]);
  }

  /**
   * How many active users can still administer the platform — used to prevent
   * locking everyone out. Defined by the PERMISSION, not a role name: roles are
   * user-created and renameable, so 'admin' is not a reliable marker. Counts
   * effective roles, so someone who is an admin only via a group still counts.
   */
  async countActiveAdmins(): Promise<number> {
    const { rows } = await this.query<{ n: string }>(
      `SELECT count(DISTINCT u.id) AS n
       FROM users u
       JOIN LATERAL (${EFFECTIVE_ROLE_IDS}) er ON TRUE
       JOIN role_permissions rp ON rp.role_id = er.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.code = 'admin:users:manage' AND u.is_active`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.query(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [
      id,
      passwordHash,
    ]);
  }

  async touchLastLogin(id: number): Promise<void> {
    await this.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [id]);
  }

  /** Replaces the full role set for a user inside one transaction. */
  async setRoles(userId: number, roleIds: number[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`DELETE FROM user_roles WHERE user_id=$1`, [userId]);
      for (const roleId of roleIds) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [userId, roleId],
        );
      }
    });
  }

  /** Case-insensitive lookup of role name -> id, for bulk imports that reference roles by name. */
  async roleIdsByName(): Promise<Map<string, number>> {
    const { rows } = await this.query<{ id: number; name: string }>(`SELECT id, name FROM roles`);
    return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  }
}
