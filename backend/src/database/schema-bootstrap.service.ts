import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { DbService } from "./db.service";

/**
 * Applies the small, additive schema this build needs, at startup.
 *
 * The db/*.sql files are still the source of truth and are applied by hand when
 * setting an environment up. The problem this solves is the gap in between: deploy
 * new code, forget the migration, and every request that touches the new table dies.
 * A login failing that way surfaces as "invalid credentials", which sends you looking
 * at the password instead of the schema.
 *
 * Only cheap, idempotent, additive statements belong here — CREATE TABLE IF NOT
 * EXISTS, ADD COLUMN IF NOT EXISTS. Nothing that rewrites a big table, nothing
 * destructive. Anything expensive (indexes over millions of rows, backfills) stays a
 * deliberate, hand-run migration.
 *
 * Best-effort: if the database user cannot run DDL, we log loudly and let the app
 * start, because a read-only-schema deployment where someone already ran the SQL is
 * perfectly valid.
 */
@Injectable()
export class SchemaBootstrapService implements OnApplicationBootstrap {
  private readonly log = new Logger(SchemaBootstrapService.name);

  constructor(private readonly db: DbService) {}

  /** Each entry: a name for logging, and the idempotent DDL to run. */
  private readonly steps: { name: string; sql: string }[] = [
    {
      name: "reports.row_limit",
      sql: `ALTER TABLE reports ADD COLUMN IF NOT EXISTS row_limit INTEGER`,
    },
    {
      // Org placement of a user: Business Unit and Sub Business Unit. Free text —
      // they mirror the Archer field values, which are not a fixed list here.
      name: "users.bu/sbu",
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS bu TEXT,
                              ADD COLUMN IF NOT EXISTS sbu TEXT`,
    },
    {
      // What a chart's breakdown matview holds. Recorded at build time because the
      // alternative — probing the matview on every read to see if it was cut off —
      // means walking millions of rows on each chart load and drill click.
      name: "chart_matview_state",
      sql: `CREATE TABLE IF NOT EXISTS chart_matview_state (
              widget_id  INT PRIMARY KEY,
              truncated  BOOLEAN NOT NULL DEFAULT FALSE,
              row_count  BIGINT,
              built_at   TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
    },
    {
      name: "user_group",
      sql: `CREATE TABLE IF NOT EXISTS user_group (
              id          SERIAL PRIMARY KEY,
              name        TEXT UNIQUE NOT NULL,
              description TEXT,
              created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
    },
    {
      name: "user_group_role",
      sql: `CREATE TABLE IF NOT EXISTS user_group_role (
              group_id INT NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
              role_id  INT NOT NULL REFERENCES roles(id)      ON DELETE CASCADE,
              PRIMARY KEY (group_id, role_id)
            )`,
    },
    {
      name: "user_group_member",
      sql: `CREATE TABLE IF NOT EXISTS user_group_member (
              group_id INT    NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
              user_id  BIGINT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
              PRIMARY KEY (group_id, user_id)
            )`,
    },
    {
      name: "ix_group_member_user",
      sql: `CREATE INDEX IF NOT EXISTS ix_group_member_user ON user_group_member (user_id)`,
    },
    // The one permanent role, and the group that carries it. Re-asserted on every
    // boot so it can't be left missing (which would mean nobody can administer the
    // platform). Only ever adds — an admin's own roles and groups are untouched.
    {
      name: "System Admin role",
      sql: `INSERT INTO roles (name, description, is_system)
            VALUES ('System Admin', 'Full platform administrator. Built-in and permanent.', TRUE)
            ON CONFLICT (name) DO UPDATE SET is_system = TRUE`,
    },
    {
      name: "System Admin permissions",
      sql: `INSERT INTO role_permissions (role_id, permission_id)
            SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
             WHERE r.name = 'System Admin'
            ON CONFLICT DO NOTHING`,
    },
    {
      name: "System Administrators group",
      sql: `INSERT INTO user_group (name, description)
            VALUES ('System Administrators', 'Members hold the System Admin role.')
            ON CONFLICT (name) DO NOTHING`,
    },
    {
      name: "System Administrators group role",
      sql: `INSERT INTO user_group_role (group_id, role_id)
            SELECT g.id, r.id FROM user_group g CROSS JOIN roles r
             WHERE g.name = 'System Administrators' AND r.name = 'System Admin'
            ON CONFLICT DO NOTHING`,
    },
    // ---- One-time transition off the old admin/analyst/viewer seed roles ----
    // These run every boot but are no-ops once done. Order matters: current admins
    // must be moved into the group BEFORE the legacy roles (which grant them admin)
    // are removed, or the last administrator would be locked out.
    {
      name: "migrate current admins into group",
      // Anyone who is an administrator right now (holds admin:users:manage via a
      // directly-assigned role) becomes a member of the System Administrators group.
      sql: `INSERT INTO user_group_member (group_id, user_id)
            SELECT g.id, u.id
              FROM user_group g
              JOIN user_roles ur       ON TRUE
              JOIN role_permissions rp ON rp.role_id = ur.role_id
              JOIN permissions p       ON p.id = rp.permission_id
              JOIN users u             ON u.id = ur.user_id
             WHERE g.name = 'System Administrators' AND p.code = 'admin:users:manage'
            ON CONFLICT DO NOTHING`,
    },
    {
      name: "seed default admin into group if empty",
      // Safety net: never leave the administrators group empty. Only fires when it is
      // (a database seeded differently), so it never fights an admin who removed people.
      sql: `INSERT INTO user_group_member (group_id, user_id)
            SELECT g.id, u.id FROM user_group g, users u
             WHERE g.name = 'System Administrators' AND u.email = 'admin@example.com'
               AND NOT EXISTS (
                 SELECT 1 FROM user_group_member m
                   JOIN user_group g2 ON g2.id = m.group_id
                  WHERE g2.name = 'System Administrators')
            ON CONFLICT DO NOTHING`,
    },
    {
      name: "remove legacy seed roles",
      // System Admin is the only built-in role. Users can never create is_system
      // roles through the app, so any OTHER is_system role is a legacy seed
      // (admin/analyst/viewer). Their user_roles/*_access rows cascade — which is the
      // whole point: direct role assignment is no longer how access works. Custom
      // roles (is_system = false) are never touched.
      sql: `DELETE FROM roles WHERE is_system AND name <> 'System Admin'`,
    },
  ];

  async onApplicationBootstrap(): Promise<void> {
    const failed: string[] = [];
    for (const step of this.steps) {
      try {
        await this.db.query(step.sql);
      } catch (e: any) {
        failed.push(step.name);
        this.log.error(`schema step '${step.name}' failed: ${e?.message ?? e}`);
      }
    }
    if (failed.length) {
      this.log.error(
        `Schema is not up to date (${failed.join(", ")}). Run the db/*.sql migrations ` +
        `against this database — parts of the app will fail until you do.`,
      );
    } else {
      this.log.log("schema up to date");
    }
  }
}
