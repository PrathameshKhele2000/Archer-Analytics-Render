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
