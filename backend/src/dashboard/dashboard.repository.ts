import { BadRequestException, Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { BaseRepository } from "../common/base.repository";
import {
  DashboardAccessRow,
  DashboardRow,
  DashboardWidgetRow,
  QUERY_BUILDER_SOURCE,
  WIDGET_DATA_SOURCES,
} from "./dashboard.entity";

@Injectable()
export class DashboardRepository extends BaseRepository<DashboardRow> {
  protected readonly table = "dashboards";

  constructor(db: DbService) {
    super(db);
  }

  /**
   * Whoever can MANAGE every dashboard can see every dashboard. Without this an
   * administrator would have to grant themselves each new dashboard by hand, and one
   * created with no grants yet would be invisible. `$n` is the role-name array.
   */
  private static adminBypass(rolesParam: string): string {
    return `EXISTS (
      SELECT 1 FROM roles ar
        JOIN role_permissions arp ON arp.role_id = ar.id
        JOIN permissions ap ON ap.id = arp.permission_id
       WHERE ar.name = ANY(${rolesParam}::text[]) AND ap.code = 'admin:dashboards:manage'
    )`;
  }

  /** Dashboards visible to this user: owned by them, granted directly, or via one of their roles. */
  async listAccessible(userId: number, roles: string[]): Promise<DashboardRow[]> {
    const { rows } = await this.query<DashboardRow>(
      `SELECT DISTINCT d.* FROM dashboards d
       LEFT JOIN dashboard_access da ON da.dashboard_id = d.id
       LEFT JOIN roles r ON r.id = da.role_id
       WHERE d.is_active AND (
         d.owner_user_id = $1
         OR da.user_id = $1
         OR r.name = ANY($2::text[])
         OR ${DashboardRepository.adminBypass("$2")}
       )
       ORDER BY d.sort_order, d.name`,
      [userId, roles],
    );
    return rows;
  }

  async findAccessibleByKey(key: string, userId: number, roles: string[]): Promise<DashboardRow | null> {
    const { rows } = await this.query<DashboardRow>(
      `SELECT DISTINCT d.* FROM dashboards d
       LEFT JOIN dashboard_access da ON da.dashboard_id = d.id
       LEFT JOIN roles r ON r.id = da.role_id
       WHERE d.key = $1 AND d.is_active AND (
         d.owner_user_id = $2
         OR da.user_id = $2
         OR r.name = ANY($3::text[])
         OR ${DashboardRepository.adminBypass("$3")}
       )`,
      [key, userId, roles],
    );
    return rows[0] ?? null;
  }

  async findByKey(key: string): Promise<DashboardRow | null> {
    const { rows } = await this.query<DashboardRow>(`SELECT * FROM dashboards WHERE key = $1`, [key]);
    return rows[0] ?? null;
  }

  /** Enum values per dropdown field, for the chart-builder's advanced filter UI. */
  async enumOptions(): Promise<Record<string, string[]>> {
    const { rows } = await this.query<{ field_key: string; value: string }>(
      "SELECT field_key, value FROM dropdown_option ORDER BY field_key, sort_order",
    );
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.field_key] ??= []).push(r.value);
    return out;
  }

  async listWidgets(dashboardId: number, activeOnly = true): Promise<DashboardWidgetRow[]> {
    const { rows } = await this.query<DashboardWidgetRow>(
      `SELECT * FROM dashboard_widgets WHERE dashboard_id=$1 ${activeOnly ? "AND is_active" : ""} ORDER BY sort_order`,
      [dashboardId],
    );
    return rows;
  }

  async runWidgetData(dataSource: string): Promise<any[]> {
    const sql = WIDGET_DATA_SOURCES[dataSource];
    if (!sql) throw new BadRequestException(`Unknown widget data source '${dataSource}'`);
    const { rows } = await this.query(sql);
    return rows;
  }

  /** Run a composed aggregation query (from the query-builder) with parameters. */
  async runAggregation(sql: string, params: any[]): Promise<any[]> {
    const { rows } = await this.query(sql, params);
    return rows;
  }

  /** Planner row estimate for a table (instant — no scan). -1 when never analyzed. */
  async estimateRows(table: string): Promise<number> {
    try {
      const { rows } = await this.query<{ n: string }>(
        `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::regclass`,
        [table],
      );
      return Number(rows[0]?.n ?? -1);
    } catch {
      return -1;
    }
  }

  // ---- Per-chart materialized views (widgetId is a DB integer -> safe to interpolate) ----

  async createChartMatview(widgetId: number, selectSql: string): Promise<void> {
    const mv = `mv_chart_${widgetId}`;
    await this.query(`DROP MATERIALIZED VIEW IF EXISTS ${mv}`);
    await this.query(`CREATE MATERIALIZED VIEW ${mv} AS ${selectSql}`);
  }

  async dropChartMatview(widgetId: number): Promise<void> {
    await this.query(`DROP MATERIALIZED VIEW IF EXISTS mv_chart_${widgetId}`);
  }

  async readChartMatview(widgetId: number): Promise<any[]> {
    const { rows } = await this.query(`SELECT * FROM mv_chart_${widgetId}`);
    return rows;
  }

  /**
   * Re-aggregate a Grouping chart's full-breakdown matview (columns g0..gN + measure
   * components) to one level: filter by the clicked values of the levels above it, group
   * by this level, and recombine the measure with `reaggExpr` (from clauseMeasureParts).
   * Reads the tiny matview, not the source table — so drilling is instant. Throws if the
   * matview doesn't exist yet (caller falls back to a live query). widgetId/level are
   * integers and reaggExpr is a whitelisted expression over fixed matview columns (safe
   * to interpolate); step values are parameterized.
   */
  async aggregateChartMatview(
    widgetId: number, level: number, stepValues: string[], limit: number, reaggExpr: string,
  ): Promise<any[]> {
    const conds = stepValues.map((_, i) => `g${i} = $${i + 1}`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await this.query(
      `SELECT g${level} AS x, ${reaggExpr} AS y
       FROM mv_chart_${widgetId}
       ${where}
       GROUP BY g${level}
       ORDER BY g${level}
       LIMIT ${Math.min(1000, Math.max(1, limit))}`,
      stepValues,
    );
    return rows;
  }

  // ---- Admin config ----

  async listAll(): Promise<DashboardRow[]> {
    return this.findAll("sort_order, name");
  }

  async create(
    key: string,
    name: string,
    description: string | undefined,
    sortOrder: number,
    ownerUserId: number | null = null,
  ) {
    const { rows } = await this.query<DashboardRow>(
      `INSERT INTO dashboards (key, name, description, sort_order, owner_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [key, name, description ?? null, sortOrder, ownerUserId],
    );
    return rows[0];
  }

  async deleteByIdCascade(id: number) {
    // dashboard_widgets & dashboard_access cascade via FK ON DELETE CASCADE.
    await this.query(`DELETE FROM dashboards WHERE id=$1`, [id]);
  }

  async update(id: number, fields: Partial<Pick<DashboardRow, "name" | "description" | "is_active" | "sort_order">>) {
    const sets: string[] = [];
    const params: any[] = [id];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k}=$${params.length}`);
    }
    if (!sets.length) return this.findById(id);
    await this.query(`UPDATE dashboards SET ${sets.join(", ")}, updated_at=now() WHERE id=$1`, params);
    return this.findById(id);
  }

  async addWidget(dashboardId: number, widget: Omit<DashboardWidgetRow, "id" | "dashboard_id">) {
    if (widget.data_source !== QUERY_BUILDER_SOURCE && !WIDGET_DATA_SOURCES[widget.data_source]) {
      throw new BadRequestException(`Unknown widget data source '${widget.data_source}'`);
    }
    const { rows } = await this.query<DashboardWidgetRow>(
      `INSERT INTO dashboard_widgets (dashboard_id, key, title, widget_type, data_source, sort_order, is_active, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        dashboardId,
        widget.key,
        widget.title,
        widget.widget_type,
        widget.data_source,
        widget.sort_order,
        widget.is_active,
        JSON.stringify(widget.config ?? {}),
      ],
    );
    return rows[0];
  }

  async updateWidget(widgetId: number, fields: Partial<Omit<DashboardWidgetRow, "id" | "dashboard_id">>) {
    const sets: string[] = [];
    const params: any[] = [widgetId];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(k === "config" ? JSON.stringify(v) : v);
      sets.push(`${k}=$${params.length}`);
    }
    if (!sets.length) return;
    await this.query(`UPDATE dashboard_widgets SET ${sets.join(", ")} WHERE id=$1`, params);
  }

  async deleteWidget(widgetId: number) {
    await this.query(`DELETE FROM dashboard_widgets WHERE id=$1`, [widgetId]);
  }

  async listAccess(dashboardId: number): Promise<(DashboardAccessRow & { role_name: string | null; user_email: string | null })[]> {
    const { rows } = await this.query<DashboardAccessRow & { role_name: string | null; user_email: string | null }>(
      `SELECT da.*, r.name AS role_name, u.email AS user_email
       FROM dashboard_access da
       LEFT JOIN roles r ON r.id = da.role_id
       LEFT JOIN users u ON u.id = da.user_id
       WHERE da.dashboard_id = $1`,
      [dashboardId],
    );
    return rows;
  }

  async grantAccess(dashboardId: number, roleId: number | null, userId: number | null) {
    const { rows } = await this.query<DashboardAccessRow>(
      `INSERT INTO dashboard_access (dashboard_id, role_id, user_id) VALUES ($1,$2,$3) RETURNING *`,
      [dashboardId, roleId, userId],
    );
    return rows[0];
  }

  async revokeAccess(accessId: number) {
    await this.query(`DELETE FROM dashboard_access WHERE id=$1`, [accessId]);
  }
}
