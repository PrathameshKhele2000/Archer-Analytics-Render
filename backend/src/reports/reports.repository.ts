import { Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { BaseRepository } from "../common/base.repository";
import {
  ReportAccessRow,
  ReportColumnRow,
  ReportContext,
  ReportFilterRow,
  ReportRow,
} from "./report.entity";
import { buildExpressionWhere, FilterCondition } from "./filterable-fields";

export interface FindingsFilter {
  conditions?: FilterCondition[];
  logic?: string | null;
  search?: string; // global quick-search across searchable columns
  colFilters?: Record<string, string>; // per-column quick-search (column key -> term)
  /** The view's preset scope — ANDed with everything above; users cannot widen past it. */
  baseConditions?: FilterCondition[];
  baseLogic?: string | null;
}

export interface FindingsQuery extends FindingsFilter {
  sort?: string;
  order?: string;
  page: number;
  size: number;
}

/**
 * Combine the view's preset scope with the user's advanced filter and the global +
 * per-column quick-search — all ANDed. The preset scope goes in first and the user's
 * expression continues its parameter numbering, so a user can only narrow a view,
 * never widen it.
 */
function whereFor(ctx: ReportContext, f: FindingsFilter): { where: string; params: any[] } {
  const clauses: string[] = [];

  const { where: baseWhere, params } = buildExpressionWhere(f.baseConditions ?? [], f.baseLogic, 0, ctx.filterFields);
  if (baseWhere) clauses.push(baseWhere.slice(6)); // strip leading "WHERE "

  const { where: exprWhere, params: userParams } = buildExpressionWhere(f.conditions ?? [], f.logic, params.length, ctx.filterFields);
  params.push(...userParams);
  if (exprWhere) clauses.push(exprWhere.slice(6));

  const term = (f.search ?? "").trim();
  if (term) {
    // Global search ORs an ILIKE across every searchable text column (each backed by a
    // trigram index). record_id is numeric — a `::text ILIKE` on it can never use an
    // index and would force a seq scan, so we skip it here and add an exact id match
    // only when the term is a plain number.
    //
    // Only push a parameter once we know a clause will actually reference it: pushing
    // it unconditionally and then adding no clause makes Postgres reject the query
    // ("bind message supplies 1 parameters, but prepared statement requires 0") — a 500
    // on every search for any dataset with no searchable columns.
    const ors: string[] = [];
    const searchCols = Object.entries(ctx.searchable).filter(([key]) => key !== "record_id");
    if (searchCols.length) {
      params.push(`%${term}%`);
      const p = `$${params.length}`;
      ors.push(...searchCols.map(([, e]) => `${e} ILIKE ${p}`));
    }
    if (/^\d+$/.test(term)) {
      params.push(Number(term));
      ors.push(`f.record_id = $${params.length}`);
    }
    if (ors.length) clauses.push(`(${ors.join(" OR ")})`);
  }
  for (const [col, val] of Object.entries(f.colFilters ?? {})) {
    const v = (val ?? "").trim();
    const expr = ctx.searchable[col];
    if (!v || !expr) continue;
    // Per-column search on the id column: exact numeric match uses the primary key.
    if (col === "record_id") {
      if (/^\d+$/.test(v)) {
        params.push(Number(v));
        clauses.push(`f.record_id = $${params.length}`);
      } else {
        params.push(`%${v}%`);
        clauses.push(`f.record_id::text ILIKE $${params.length}`);
      }
      continue;
    }
    params.push(`%${v}%`);
    clauses.push(`${expr} ILIKE $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

@Injectable()
export class ReportsRepository extends BaseRepository<ReportRow> {
  protected readonly table = "reports";

  constructor(db: DbService) {
    super(db);
  }

  // ---- Access ----

  /**
   * Whoever can MANAGE every view can obviously see every view. Without this an
   * administrator would have to grant themselves each new view one at a time, and a
   * view created with no grants yet would be invisible even to the person who made it.
   * `$n` is the caller's role-name array.
   */
  private static adminBypass(rolesParam: string, permission: string): string {
    return `EXISTS (
      SELECT 1 FROM roles ar
        JOIN role_permissions arp ON arp.role_id = ar.id
        JOIN permissions ap ON ap.id = arp.permission_id
       WHERE ar.name = ANY(${rolesParam}::text[]) AND ap.code = '${permission}'
    )`;
  }

  async listAccessible(userId: number, roles: string[]): Promise<ReportRow[]> {
    // LEFT JOIN, not JOIN: a view with no grants at all must still be reachable by an
    // administrator (an inner join would drop it before the bypass could apply).
    const { rows } = await this.query<ReportRow>(
      `SELECT DISTINCT r.* FROM reports r
       LEFT JOIN report_access ra ON ra.report_id = r.id
       LEFT JOIN roles ro ON ro.id = ra.role_id
       WHERE r.is_active AND (
         ra.user_id = $1
         OR ro.name = ANY($2::text[])
         OR ${ReportsRepository.adminBypass("$2", "admin:reports:manage")}
       )
       ORDER BY r.name`,
      [userId, roles],
    );
    return rows;
  }

  async findAccessibleByKey(key: string, userId: number, roles: string[]): Promise<ReportRow | null> {
    const { rows } = await this.query<ReportRow>(
      `SELECT DISTINCT r.* FROM reports r
       LEFT JOIN report_access ra ON ra.report_id = r.id
       LEFT JOIN roles ro ON ro.id = ra.role_id
       WHERE r.key = $1 AND r.is_active AND (
         ra.user_id = $2
         OR ro.name = ANY($3::text[])
         OR ${ReportsRepository.adminBypass("$3", "admin:reports:manage")}
       )`,
      [key, userId, roles],
    );
    return rows[0] ?? null;
  }

  // ---- Config: columns & filters ----

  async listColumns(reportId: number): Promise<ReportColumnRow[]> {
    const { rows } = await this.query<ReportColumnRow>(
      `SELECT * FROM report_columns WHERE report_id=$1 ORDER BY sort_order`,
      [reportId],
    );
    return rows;
  }

  async listFilters(reportId: number): Promise<ReportFilterRow[]> {
    const { rows } = await this.query<ReportFilterRow>(
      `SELECT * FROM report_filters WHERE report_id=$1 ORDER BY sort_order`,
      [reportId],
    );
    return rows;
  }

  // ---- Records data (built per dataset from its catalog via ReportContext) ----

  private selectList(ctx: ReportContext): string {
    return ctx.selectCols.map((c) => `${c.expr} AS ${c.key}`).join(", ");
  }

  /** Exact matching-row count (the expensive part over big tables — cache it). */
  /**
   * How many rows match. Counting is the expensive half of a records page: over a big
   * table a broad filter can match millions and an exact count(*) then costs seconds
   * (measured: 7.6s at 10M rows) while the page itself takes 5ms.
   *
   * So we count exactly only while it's cheap, and stop at COUNT_CAP otherwise —
   * the UI shows "10,000+". Same trick every large search engine uses.
   * Returns `capped: true` when the real total is higher than the number returned.
   */
  async countFindings(
    ctx: ReportContext, q: FindingsQuery,
  ): Promise<{ total: number; capped: boolean; estimated?: boolean }> {
    const { where, params } = whereFor(ctx, q);

    // No filter at all: use Postgres' own row estimate on very large tables (instant).
    // It drifts ~1% between ANALYZEs, so only above a threshold where an exact count
    // would actually hurt (a 100k count(*) is ~25ms — accuracy is worth more there).
    const ESTIMATE_ABOVE_ROWS = 2_000_000;
    if (!where) {
      const est = await this.query<{ n: number }>(
        `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::regclass`,
        [ctx.table],
      ).catch(() => null);
      const n = Number(est?.rows?.[0]?.n ?? -1);
      // Flag it as an estimate so the UI can show "~10,000,000" — otherwise the number
      // looks wrong (it's off by a fraction of a percent and drifts between loads).
      if (n >= ESTIMATE_ABOVE_ROWS) return { total: n, capped: false, estimated: true };

      const { rows } = await this.query<{ count: number }>(
        `SELECT count(*)::bigint AS count ${ctx.baseFrom} ${where}`,
        params,
      );
      return { total: Number(rows[0].count), capped: false };
    }

    // Filtered: stop counting once past the cap. Postgres short-circuits the inner
    // LIMIT, so cost is bounded no matter how many rows actually match.
    const CAP = 10_000;
    const { rows } = await this.query<{ count: number }>(
      `SELECT count(*)::bigint AS count FROM (SELECT 1 ${ctx.baseFrom} ${where} LIMIT ${CAP + 1}) x`,
      params,
    );
    const n = Number(rows[0].count);
    return { total: Math.min(n, CAP), capped: n > CAP };
  }

  /** One page of rows (index-served, fast regardless of table size). */
  async pageFindings(ctx: ReportContext, q: FindingsQuery): Promise<any[]> {
    const { where, params } = whereFor(ctx, q);
    const sortCol = ctx.sortable[q.sort ?? ""] ?? ctx.defaultSortExpr;
    const direction = (q.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    // Order the tie-breaker in the SAME direction as the sort column and use Postgres'
    // default NULL placement. That lets a single plain (col, record_id) index serve both
    // directions via a forward / backward Index Only Scan. Forcing "NULLS LAST" or a
    // fixed-direction tie-breaker breaks the match and makes Postgres sort the WHOLE
    // table for one page (measured at 10M rows: 7.6s -> 13ms).
    const orderBy = `${sortCol} ${direction}, f.record_id ${direction}`;
    const offset = (q.page - 1) * q.size;

    // Deep pages: OFFSET makes the executor build and throw away every skipped row —
    // with ~50 wide columns that means fetching 200k full rows to return 25 (41s at 10M).
    // Instead resolve the page's ids first (narrow, index-only) and join back for just
    // those rows: 41s -> 0.4s. Only worth the extra join once the offset is large.
    const DEFER_JOIN_ABOVE_OFFSET = 1_000;
    if (offset > DEFER_JOIN_ABOVE_OFFSET) {
      const keys = `SELECT f.record_id ${ctx.baseFrom} ${where}
                    ORDER BY ${orderBy} LIMIT ${q.size} OFFSET ${offset}`;
      const { rows } = await this.query(
        `SELECT ${this.selectList(ctx)}
         FROM ${ctx.table} f
         JOIN (${keys}) k ON k.record_id = f.record_id
         ORDER BY ${orderBy}`,
        params,
      );
      return rows;
    }

    const { rows } = await this.query(
      `SELECT ${this.selectList(ctx)} ${ctx.baseFrom} ${where}
       ORDER BY ${orderBy}
       LIMIT ${q.size} OFFSET ${offset}`,
      params,
    );
    return rows;
  }

  /** Streams all matching rows in fixed-size chunks via keyset pagination (constant memory). */
  async *streamFindings(ctx: ReportContext, filters: FindingsFilter): AsyncGenerator<any[]> {
    const { where, params } = whereFor(ctx, filters);
    const CHUNK = 10_000;
    let cursor: { id: number } | null = null;
    for (;;) {
      const p = [...params];
      let keyset = "";
      if (cursor) {
        p.push(cursor.id);
        keyset = `${where ? "AND" : "WHERE"} f.record_id < $${p.length}::bigint`;
      }
      const { rows } = await this.query(
        `SELECT ${this.selectList(ctx)} ${ctx.baseFrom} ${where} ${keyset}
         ORDER BY f.record_id DESC LIMIT ${CHUNK}`,
        p,
      );
      if (rows.length === 0) return;
      yield rows;
      const last = rows[rows.length - 1] as any;
      cursor = { id: last.record_id };
      if (rows.length < CHUNK) return;
    }
  }

  /** Enum options keyed by dropdown field key, from the dropdown_option catalog. */
  async enumOptions(): Promise<Record<string, string[]>> {
    const { rows } = await this.query<{ field_key: string; value: string }>(
      "SELECT field_key, value FROM dropdown_option ORDER BY field_key, sort_order",
    );
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.field_key] ??= []).push(r.value);
    return out;
  }

  /** Key lookup ignoring access/active — used to keep generated view keys unique. */
  async findByKeyRaw(key: string): Promise<ReportRow | null> {
    const { rows } = await this.query<ReportRow>(`SELECT * FROM reports WHERE key = $1`, [key]);
    return rows[0] ?? null;
  }

  // ---- Record Views (admin) ----

  /** Every view with its preset filter, chosen columns and the roles that can see it. */
  async listViews() {
    const { rows } = await this.query(
      `SELECT r.*,
              COALESCE((SELECT json_agg(c.key ORDER BY c.sort_order)
                        FROM report_columns c WHERE c.report_id = r.id), '[]') AS columns,
              COALESCE((SELECT json_agg(DISTINCT ra.role_id)
                        FROM report_access ra WHERE ra.report_id = r.id AND ra.role_id IS NOT NULL), '[]') AS role_ids
       FROM reports r ORDER BY r.sort_order, r.name`,
    );
    return rows;
  }

  async createView(v: {
    key: string; name: string; description?: string | null; datasetKey: string; dataSource: string;
    baseConditions: any[]; baseLogic?: string | null; rowLimit?: number | null; sortOrder?: number;
  }): Promise<ReportRow> {
    const { rows } = await this.query<ReportRow>(
      `INSERT INTO reports (key, name, description, data_source, dataset_key, base_conditions, base_logic, row_limit, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
      [v.key, v.name, v.description ?? null, v.dataSource, v.datasetKey,
       JSON.stringify(v.baseConditions ?? []), v.baseLogic || null, v.rowLimit ?? null, v.sortOrder ?? 10],
    );
    return rows[0];
  }

  async updateView(id: number, v: {
    name?: string; description?: string | null;
    baseConditions?: any[]; baseLogic?: string | null;
    rowLimit?: number | null; isActive?: boolean; sortOrder?: number;
  }): Promise<ReportRow | null> {
    // row_limit and base_logic are assigned directly, not COALESCEd: null is a real
    // value for both ("show all rows" / "AND everything") and must be settable.
    const { rows } = await this.query<ReportRow>(
      `UPDATE reports SET
         name            = COALESCE($2, name),
         description     = COALESCE($3, description),
         base_conditions = COALESCE($4::jsonb, base_conditions),
         base_logic      = $5,
         row_limit       = $6,
         is_active       = COALESCE($7, is_active),
         sort_order      = COALESCE($8, sort_order),
         updated_at      = now()
       WHERE id = $1 RETURNING *`,
      [
        id, v.name ?? null, v.description ?? null,
        v.baseConditions ? JSON.stringify(v.baseConditions) : null,
        v.baseLogic || null, v.rowLimit ?? null, v.isActive ?? null, v.sortOrder ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  async deleteView(id: number) {
    await this.query(`DELETE FROM reports WHERE id = $1`, [id]);
  }

  /** Replace a view's column set (ordered). */
  async setColumns(reportId: number, cols: { key: string; label: string }[]) {
    await this.query(`DELETE FROM report_columns WHERE report_id = $1`, [reportId]);
    for (let i = 0; i < cols.length; i++) {
      await this.query(
        `INSERT INTO report_columns (report_id, key, label, sortable, is_default_visible, sort_order)
         VALUES ($1,$2,$3,TRUE,TRUE,$4)`,
        [reportId, cols[i].key, cols[i].label, i],
      );
    }
  }

  /** Replace which roles can see a view. */
  async setAccessRoles(reportId: number, roleIds: number[]) {
    await this.query(`DELETE FROM report_access WHERE report_id = $1 AND role_id IS NOT NULL`, [reportId]);
    for (const roleId of roleIds) {
      await this.query(`INSERT INTO report_access (report_id, role_id, user_id) VALUES ($1,$2,NULL)`, [reportId, roleId]);
    }
  }

  // ---- Admin config ----

  async listAll(): Promise<ReportRow[]> {
    return this.findAll("name");
  }

  async create(key: string, name: string, description: string | undefined, dataSource: string) {
    const { rows } = await this.query<ReportRow>(
      `INSERT INTO reports (key, name, description, data_source) VALUES ($1,$2,$3,$4) RETURNING *`,
      [key, name, description ?? null, dataSource],
    );
    return rows[0];
  }

  async update(id: number, fields: Partial<Pick<ReportRow, "name" | "description" | "is_active">>) {
    const sets: string[] = [];
    const params: any[] = [id];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k}=$${params.length}`);
    }
    if (!sets.length) return this.findById(id);
    await this.query(`UPDATE reports SET ${sets.join(", ")}, updated_at=now() WHERE id=$1`, params);
    return this.findById(id);
  }

  async upsertColumn(reportId: number, col: Omit<ReportColumnRow, "id" | "report_id">) {
    const { rows } = await this.query<ReportColumnRow>(
      `INSERT INTO report_columns (report_id, key, label, sortable, is_default_visible, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (report_id, key) DO UPDATE SET
         label=EXCLUDED.label, sortable=EXCLUDED.sortable,
         is_default_visible=EXCLUDED.is_default_visible, sort_order=EXCLUDED.sort_order
       RETURNING *`,
      [reportId, col.key, col.label, col.sortable, col.is_default_visible, col.sort_order],
    );
    return rows[0];
  }

  async deleteColumn(columnId: number) {
    await this.query(`DELETE FROM report_columns WHERE id=$1`, [columnId]);
  }

  async upsertFilter(reportId: number, f: Omit<ReportFilterRow, "id" | "report_id">) {
    const { rows } = await this.query<ReportFilterRow>(
      `INSERT INTO report_filters (report_id, key, label, filter_type, source, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (report_id, key) DO UPDATE SET
         label=EXCLUDED.label, filter_type=EXCLUDED.filter_type,
         source=EXCLUDED.source, sort_order=EXCLUDED.sort_order
       RETURNING *`,
      [reportId, f.key, f.label, f.filter_type, f.source ?? null, f.sort_order],
    );
    return rows[0];
  }

  async deleteFilter(filterId: number) {
    await this.query(`DELETE FROM report_filters WHERE id=$1`, [filterId]);
  }

  async listAccess(reportId: number) {
    const { rows } = await this.query(
      `SELECT ra.*, r.name AS role_name, u.email AS user_email
       FROM report_access ra
       LEFT JOIN roles r ON r.id = ra.role_id
       LEFT JOIN users u ON u.id = ra.user_id
       WHERE ra.report_id = $1`,
      [reportId],
    );
    return rows;
  }

  async grantAccess(reportId: number, roleId: number | null, userId: number | null) {
    const { rows } = await this.query<ReportAccessRow>(
      `INSERT INTO report_access (report_id, role_id, user_id) VALUES ($1,$2,$3) RETURNING *`,
      [reportId, roleId, userId],
    );
    return rows[0];
  }

  async revokeAccess(accessId: number) {
    await this.query(`DELETE FROM report_access WHERE id=$1`, [accessId]);
  }
}
