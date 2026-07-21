import { Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { BaseRepository } from "../common/base.repository";
import { PermissionRow, RoleRow } from "./role.entity";

@Injectable()
export class RolesRepository extends BaseRepository<RoleRow> {
  protected readonly table = "roles";

  constructor(db: DbService) {
    super(db);
  }

  /**
   * A role with its permissions AND the specific views/dashboards it can read.
   * The grants are correlated subqueries rather than more joins: joining three
   * one-to-many tables at once multiplies rows, and array_agg would then need
   * DISTINCT everywhere to undo the fan-out.
   */
  private static readonly ROLE_SELECT = `
    SELECT r.*,
      coalesce(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions,
      coalesce((SELECT array_agg(ra.report_id)    FROM report_access ra    WHERE ra.role_id = r.id), '{}') AS view_ids,
      coalesce((SELECT array_agg(da.dashboard_id) FROM dashboard_access da WHERE da.role_id = r.id), '{}') AS dashboard_ids
    FROM roles r
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
  `;

  async listWithPermissions(): Promise<RoleRow[]> {
    const { rows } = await this.query<RoleRow>(
      `${RolesRepository.ROLE_SELECT} GROUP BY r.id ORDER BY r.name`,
    );
    return rows;
  }

  async findByIdWithPermissions(id: number): Promise<RoleRow | null> {
    const { rows } = await this.query<RoleRow>(
      `${RolesRepository.ROLE_SELECT} WHERE r.id = $1 GROUP BY r.id`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Views and dashboards a role can be granted read access to. */
  async listGrantableResources() {
    const [views, dashboards] = await Promise.all([
      this.query<{ id: number; key: string; name: string }>(
        `SELECT id, key, name FROM reports WHERE is_active ORDER BY sort_order, name`,
      ),
      this.query<{ id: number; key: string; name: string }>(
        `SELECT id, key, name FROM dashboards ORDER BY name`,
      ),
    ]);
    return { views: views.rows, dashboards: dashboards.rows };
  }

  /**
   * Replace which views/dashboards this role can read. Only the role's own grants
   * are touched — per-user grants (user_id rows) in the same tables are left alone.
   * Passing undefined leaves that resource type untouched, so the two lists can be
   * saved independently.
   */
  async setResourceGrants(roleId: number, viewIds?: number[], dashboardIds?: number[]): Promise<void> {
    await this.transaction(async (client) => {
      if (viewIds) {
        await client.query(`DELETE FROM report_access WHERE role_id = $1`, [roleId]);
        for (const id of viewIds) {
          await client.query(
            `INSERT INTO report_access (report_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, roleId],
          );
        }
      }
      if (dashboardIds) {
        await client.query(`DELETE FROM dashboard_access WHERE role_id = $1`, [roleId]);
        for (const id of dashboardIds) {
          await client.query(
            `INSERT INTO dashboard_access (dashboard_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, roleId],
          );
        }
      }
    });
  }

  async listPermissions(): Promise<PermissionRow[]> {
    const { rows } = await this.query<PermissionRow>(`SELECT * FROM permissions ORDER BY code`);
    return rows;
  }

  async create(name: string, description?: string): Promise<RoleRow & { permissions: string[] }> {
    const { rows } = await this.query<any>(
      `INSERT INTO roles (name, description) VALUES ($1,$2) RETURNING *`,
      [name, description ?? null],
    );
    return { ...rows[0], permissions: [] };
  }

  async findByName(name: string): Promise<RoleRow | null> {
    const { rows } = await this.query<RoleRow>(`SELECT * FROM roles WHERE lower(name) = lower($1)`, [name]);
    return rows[0] ?? null;
  }

  async updateDescription(id: number, description?: string): Promise<void> {
    await this.query(`UPDATE roles SET description=$2 WHERE id=$1`, [id, description ?? null]);
  }

  async findById(id: number): Promise<RoleRow | null> {
    const { rows } = await this.query<RoleRow>(`SELECT * FROM roles WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }

  /** How many users currently hold this role (so we can warn before deleting). */
  async countUsers(id: number): Promise<number> {
    const { rows } = await this.query<{ n: string }>(
      `SELECT count(*) AS n FROM user_roles WHERE role_id=$1`, [id],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async delete(id: number): Promise<void> {
    // role_permissions / user_roles cascade via ON DELETE CASCADE.
    await this.query(`DELETE FROM roles WHERE id=$1`, [id]);
  }

  /** Permission ids for a fixed set of codes (unknown codes are simply absent). */
  async permissionIdsForCodes(codes: string[]): Promise<number[]> {
    const { rows } = await this.query<{ id: number }>(
      `SELECT id FROM permissions WHERE code = ANY($1::text[])`, [codes],
    );
    return rows.map((r) => r.id);
  }

  /** Case-insensitive lookup of permission code -> id, for bulk role imports. */
  async permissionIdsByCode(): Promise<Map<string, number>> {
    const { rows } = await this.query<{ id: number; code: string }>(`SELECT id, code FROM permissions`);
    return new Map(rows.map((r) => [r.code.toLowerCase(), r.id]));
  }

  async setPermissions(roleId: number, permissionIds: number[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`DELETE FROM role_permissions WHERE role_id=$1`, [roleId]);
      for (const permissionId of permissionIds) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [roleId, permissionId],
        );
      }
    });
  }
}
