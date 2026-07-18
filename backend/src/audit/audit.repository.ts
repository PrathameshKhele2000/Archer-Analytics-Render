import { Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { BaseRepository } from "../common/base.repository";

export interface AuditLogRow {
  id: number;
  user_id: number | null;
  user_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  method: string | null;
  path: string | null;
  ip_address: string | null;
  before_state: unknown;
  after_state: unknown;
  status_code: number | null;
  created_at: string;
}

export interface AuditEntry {
  userId: number | null;
  userEmail: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  method?: string | null;
  path?: string | null;
  ipAddress?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  statusCode?: number | null;
}

@Injectable()
export class AuditRepository extends BaseRepository<AuditLogRow> {
  protected readonly table = "audit_log";

  constructor(db: DbService) {
    super(db);
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.query(
      `INSERT INTO audit_log
         (user_id, user_email, action, entity_type, entity_id, method, path, ip_address,
          before_state, after_state, status_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        entry.userId,
        entry.userEmail,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.method ?? null,
        entry.path ?? null,
        entry.ipAddress ?? null,
        entry.beforeState ? JSON.stringify(entry.beforeState) : null,
        entry.afterState ? JSON.stringify(entry.afterState) : null,
        entry.statusCode ?? null,
      ],
    );
  }

  async search(params: {
    userId?: number;
    action?: string;
    entityType?: string;
    from?: string;
    to?: string;
    page: number;
    size: number;
  }): Promise<{ total: number; rows: AuditLogRow[] }> {
    const clauses: string[] = [];
    const values: any[] = [];
    if (params.userId) {
      values.push(params.userId);
      clauses.push(`user_id = $${values.length}`);
    }
    if (params.action) {
      values.push(params.action);
      clauses.push(`action = $${values.length}`);
    }
    if (params.entityType) {
      values.push(params.entityType);
      clauses.push(`entity_type = $${values.length}`);
    }
    if (params.from) {
      values.push(params.from);
      clauses.push(`created_at >= $${values.length}`);
    }
    if (params.to) {
      values.push(params.to);
      clauses.push(`created_at <= $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [countRes, dataRes] = await Promise.all([
      this.query<{ count: number }>(`SELECT count(*)::int AS count FROM audit_log ${where}`, values),
      this.query<AuditLogRow>(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${params.size} OFFSET ${(params.page - 1) * params.size}`,
        values,
      ),
    ]);
    return { total: countRes.rows[0].count, rows: dataRes.rows };
  }
}
