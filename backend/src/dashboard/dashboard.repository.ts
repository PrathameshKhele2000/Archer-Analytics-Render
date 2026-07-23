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
import { BREAKDOWN_MATVIEW_CAP, CHART_TOP_GROUPS, MAX_CHART_GROUPS, OTHER_LABEL_PREFIX } from "./query-builder";

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

  /**
   * Build a chart's matview and swap it in atomically.
   *
   * Populating takes seconds to minutes on a large table, so it happens under a scratch
   * name first; only the rename is visible to readers, and it runs in one transaction.
   * Dropping the live view up front (the obvious way) would leave every reader without a
   * matview for the whole build, pushing them onto slow source-table queries — which on a
   * busy dashboard is exactly when that hurts most.
   */
  async createChartMatview(widgetId: number, selectSql: string): Promise<void> {
    const mv = `mv_chart_${widgetId}`;
    const tmp = `${mv}_build`;
    await this.query(`DROP MATERIALIZED VIEW IF EXISTS ${tmp}`);
    await this.query(`CREATE MATERIALIZED VIEW ${tmp} AS ${selectSql}`);

    // Record whether the breakdown fitted, so readers don't have to walk the matview to
    // find out. Counting once here costs a scan; probing on every read cost one per click.
    const { rows: cnt } = await this.query<{ n: string }>(`SELECT count(*) AS n FROM ${tmp}`);
    const rowCount = Number(cnt[0]?.n ?? 0);
    const truncated = rowCount > BREAKDOWN_MATVIEW_CAP;

    // Drilling filters on the leading level columns (g0, g0+g1, …), so one index over
    // them in order serves every level via its prefix. Named uniquely: the outgoing
    // matview still owns its own index until the swap drops it.
    const { rows: cols } = await this.query<{ attname: string }>(
      `SELECT a.attname FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
        WHERE c.relname = $1 AND a.attname ~ '^g[0-9]+$'
        ORDER BY a.attnum`,
      [tmp],
    );
    if (cols.length) {
      const idx = `${mv}_gidx_${Date.now().toString(36)}`;
      await this.query(`CREATE INDEX ${idx} ON ${tmp} (${cols.map((c) => c.attname).join(", ")})`);
    }

    await this.transaction(async (client) => {
      await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${mv}`);
      await client.query(`ALTER MATERIALIZED VIEW ${tmp} RENAME TO ${mv}`);
      await client.query(
        `INSERT INTO chart_matview_state (widget_id, truncated, row_count, built_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (widget_id) DO UPDATE
            SET truncated = EXCLUDED.truncated,
                row_count = EXCLUDED.row_count,
                built_at  = EXCLUDED.built_at`,
        [widgetId, truncated, rowCount],
      );
    });
  }

  async dropChartMatview(widgetId: number): Promise<void> {
    await this.query(`DROP MATERIALIZED VIEW IF EXISTS mv_chart_${widgetId}`);
    await this.query(`DROP MATERIALIZED VIEW IF EXISTS mv_chart_${widgetId}_build`);
    await this.query(`DELETE FROM chart_matview_state WHERE widget_id = $1`, [widgetId]);
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
  /**
   * Did this chart have more level-combinations than the breakdown can hold? Reading an
   * incomplete breakdown would silently under-count, so callers must query the source
   * instead. Throws if the matview doesn't exist yet (caller rebuilds).
   *
   * Treats "exactly CAP rows" as truncated, not just CAP + 1. The build asks for CAP + 1
   * so a full breakdown is distinguishable, but matviews written before that used a plain
   * LIMIT CAP and look identical to complete ones at CAP. Erring this way costs a little
   * speed on the one chart that lands on exactly CAP combinations; erring the other way
   * would serve wrong numbers, and old matviews would stay wrong until rebuilt.
   *
   * A truncated matview is left in place on purpose: it is the cheap, persistent record of
   * "this chart can't be pre-aggregated", so a doomed build isn't re-run on every load.
   */
  async breakdownTruncated(widgetId: number): Promise<boolean> {
    const { rows } = await this.query<{ truncated: boolean }>(
      `SELECT truncated FROM chart_matview_state WHERE widget_id = $1`,
      [widgetId],
    );
    if (rows.length) return rows[0].truncated;

    // No record: the matview predates this bookkeeping. Work it out the expensive way
    // once (this also confirms the matview exists — the caller rebuilds if it doesn't),
    // then store the answer so no later read pays for it.
    const { rows: probe } = await this.query(
      `SELECT 1 FROM mv_chart_${widgetId} OFFSET ${BREAKDOWN_MATVIEW_CAP} LIMIT 1`,
    );
    const truncated = probe.length > 0;
    await this.query(
      `INSERT INTO chart_matview_state (widget_id, truncated) VALUES ($1, $2)
       ON CONFLICT (widget_id) DO UPDATE SET truncated = EXCLUDED.truncated`,
      [widgetId, truncated],
    );
    return truncated;
  }

  async aggregateChartMatview(
    widgetId: number, level: number, stepValues: string[], limit: number, reaggExpr: string,
    /** Keep the split-by series (base level of a split chart); drill levels drop it. */
    withSeries = false,
  ): Promise<any[]> {
    const mv = `mv_chart_${widgetId}`;
    const conds = stepValues.map((_, i) => `g${i} = $${i + 1}`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sel = withSeries ? `g${level} AS x, s AS series` : `g${level} AS x`;
    const grp = withSeries ? `g${level}, s` : `g${level}`;
    const cap = Math.min(MAX_CHART_GROUPS, Math.max(1, limit));

    // Ask for one past the "too many to draw" threshold. Within it, the level is returned
    // in the dimension's own order exactly as before — small charts are untouched.
    const { rows } = await this.query(
      // o<level> carries the dimension's own ordering; it is functionally dependent on
      // g<level>, so min() just picks it up without widening the grouping.
      `SELECT ${sel}, ${reaggExpr} AS y
       FROM ${mv}
       ${where}
       GROUP BY ${grp}
       ORDER BY min(o${level})
       LIMIT ${Math.min(cap, CHART_TOP_GROUPS + 1)}`,
      stepValues,
    );
    if (rows.length <= CHART_TOP_GROUPS || withSeries) return rows;

    // Too many to draw. Return the biggest CHART_TOP_GROUPS and fold the rest into one
    // "Other" bar, re-aggregated from the same stored components — so an avg stays a true
    // weighted average and a sum stays exact, rather than an average of averages.
    // The tail is re-aggregated from the matview rows of the non-top groups. Joining on
    // the group value has to be NULL-safe (a group can BE null), but IS NOT DISTINCT FROM
    // is not hashable — Postgres falls back to a nested loop over hundreds of thousands of
    // rows, which took minutes. Comparing a coalesced surrogate keeps it a hash join.
    // Everything here is cast to text on purpose. A grouping level is not always text —
    // it can be an integer, date or timestamp — and both the NULL-safe join key and the
    // UNION with the literal "Other" label need one common type. ::text is injective for
    // these types, so identity is preserved.
    const NULL_KEY = "__aa_null__";
    const keyOf = (col: string) => `coalesce(${col}::text, '${NULL_KEY}')`;
    const { rows: rolled } = await this.query(
      `WITH lvl AS (
         SELECT g${level} AS x, ${reaggExpr} AS y
           FROM ${mv} ${where}
          GROUP BY g${level}
       ),
       ranked AS (
         SELECT x, y, row_number() OVER (ORDER BY y DESC NULLS LAST, x) AS rn FROM lvl
       ),
       tail AS (
         SELECT ${keyOf("x")} AS k FROM ranked WHERE rn > ${CHART_TOP_GROUPS}
       ),
       rest AS (
         SELECT ${reaggExpr} AS y
           FROM ${mv} m
           JOIN tail t ON t.k = ${keyOf(`m.g${level}`)}
          ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       )
       SELECT x, y FROM (
         SELECT x::text AS x, y, rn AS ord FROM ranked WHERE rn <= ${CHART_TOP_GROUPS}
         UNION ALL
         SELECT '${OTHER_LABEL_PREFIX}' || (SELECT count(*) FROM tail) || ' more)',
                (SELECT y FROM rest),
                ${CHART_TOP_GROUPS + 1}
       ) o ORDER BY ord`,
      stepValues,
    );
    return rolled;
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
