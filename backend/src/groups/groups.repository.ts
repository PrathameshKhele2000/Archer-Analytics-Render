import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../common/base.repository";
import { DbService } from "../database/db.service";
import { GroupRow } from "./group.entity";

@Injectable()
export class GroupsRepository extends BaseRepository<GroupRow> {
  protected readonly table = "user_group";

  constructor(db: DbService) {
    super(db);
  }

  // Roles and members are correlated subqueries rather than joins: joining both
  // one-to-many tables at once multiplies rows and the counts come out wrong.
  private static readonly GROUP_SELECT = `
    SELECT g.*,
      coalesce((SELECT array_agg(gr.role_id ORDER BY gr.role_id)
                  FROM user_group_role gr WHERE gr.group_id = g.id), '{}') AS role_ids,
      coalesce((SELECT array_agg(ro.name ORDER BY ro.name)
                  FROM user_group_role gr JOIN roles ro ON ro.id = gr.role_id
                 WHERE gr.group_id = g.id), '{}') AS role_names,
      -- ::int matters. users.id is BIGINT, and the driver only parses scalar int8 —
      -- a bigint[] comes back as an array of STRINGS, which then fails every
      -- id comparison in the UI. int4[] is parsed into numbers.
      coalesce((SELECT array_agg(gm.user_id::int ORDER BY gm.user_id)
                  FROM user_group_member gm WHERE gm.group_id = g.id), '{}') AS user_ids,
      (SELECT count(*) FROM user_group_member gm WHERE gm.group_id = g.id)::int AS member_count
    FROM user_group g
  `;

  async listAll(): Promise<GroupRow[]> {
    const { rows } = await this.query<GroupRow>(`${GroupsRepository.GROUP_SELECT} ORDER BY g.name`);
    return rows;
  }

  async findByIdFull(id: number): Promise<GroupRow | null> {
    const { rows } = await this.query<GroupRow>(`${GroupsRepository.GROUP_SELECT} WHERE g.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async findByName(name: string): Promise<GroupRow | null> {
    const { rows } = await this.query<GroupRow>(
      `SELECT * FROM user_group WHERE lower(name) = lower($1)`, [name],
    );
    return rows[0] ?? null;
  }

  async insert(name: string, description?: string | null): Promise<{ id: number }> {
    const { rows } = await this.query<{ id: number }>(
      `INSERT INTO user_group (name, description) VALUES ($1,$2) RETURNING id`,
      [name, description ?? null],
    );
    return rows[0];
  }

  async updateDetails(id: number, name?: string, description?: string | null): Promise<void> {
    await this.query(
      `UPDATE user_group SET name = COALESCE($2, name), description = $3, updated_at = now() WHERE id = $1`,
      [id, name ?? null, description ?? null],
    );
  }

  /** Replace the group's roles and/or members. Undefined leaves that set untouched. */
  async setMembership(id: number, roleIds?: number[], userIds?: number[]): Promise<void> {
    await this.transaction(async (client) => {
      if (roleIds) {
        await client.query(`DELETE FROM user_group_role WHERE group_id = $1`, [id]);
        for (const roleId of roleIds) {
          await client.query(
            `INSERT INTO user_group_role (group_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, roleId],
          );
        }
      }
      if (userIds) {
        await client.query(`DELETE FROM user_group_member WHERE group_id = $1`, [id]);
        for (const userId of userIds) {
          await client.query(
            `INSERT INTO user_group_member (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, userId],
          );
        }
      }
    });
  }

  async remove(id: number): Promise<void> {
    // user_group_role / user_group_member cascade via ON DELETE CASCADE.
    await this.query(`DELETE FROM user_group WHERE id = $1`, [id]);
  }
}
