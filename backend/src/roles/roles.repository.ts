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

  async listWithPermissions(): Promise<RoleRow[]> {
    const { rows } = await this.query<RoleRow>(`
      SELECT r.*, coalesce(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN permissions p ON p.id = rp.permission_id
      GROUP BY r.id ORDER BY r.name
    `);
    return rows;
  }

  async findByIdWithPermissions(id: number): Promise<RoleRow | null> {
    const { rows } = await this.query<RoleRow>(
      `SELECT r.*, coalesce(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE r.id = $1 GROUP BY r.id`,
      [id],
    );
    return rows[0] ?? null;
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
