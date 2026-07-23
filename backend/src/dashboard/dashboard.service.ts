import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { AuthenticatedUser } from "../auth/jwt-payload.interface";
import { DATA_SOURCE_CATALOG, QUERY_BUILDER_SOURCE } from "./dashboard.entity";
import { DashboardRepository } from "./dashboard.repository";
import { buildAggregation, buildAggregationInline, buildBreakdownMatviewInline, buildDrill, buildRecordsChartQuery, buildRecordsQuery, ChartSpec, clauseMeasureParts, drillSequence, DrillStep, CHART_TOP_GROUPS, groupAggOf, MAX_CHART_GROUPS, measureReaggParts, OTHER_LABEL_PREFIX, mergeScope, schemaCatalog } from "./query-builder";
import { Logger } from "@nestjs/common";
import { CatalogService } from "../datasets/catalog.service";
import { ReportsService } from "../reports/reports.service";
import {
  AddChartWidgetDto,
  ChartSpecDto,
  CreateDashboardDto,
  CreateMyDashboardDto,
  CreateWidgetDto,
  GrantAccessDto,
  UpdateChartWidgetDto,
  UpdateDashboardDto,
  UpdateMyDashboardDto,
  UpdateWidgetDto,
} from "./dto/dashboard.dto";

const DEFAULT_DATASET = "archer-findings";

/**
 * Groups shown per chart level: all of them, up to the safety ceiling. This used to
 * default to 50 while the live/preview path defaulted to 500, which is why a saved
 * chart could show fewer bars than the preview it was designed from.
 */
function resolveChartLimit(_limit?: number | null): number {
  return MAX_CHART_GROUPS;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "dashboard";
}

@Injectable()
export class DashboardService {
  private readonly log = new Logger(DashboardService.name);

  constructor(
    private readonly repo: DashboardRepository,
    private readonly cache: CacheService,
    private readonly catalogs: CatalogService,
    private readonly reports: ReportsService,
  ) {}

  /**
   * Resolve a chart spec before it queries. For a Personalized Dashboard chart
   * (spec.viewKey set), this validates the user can access that view (throws 403/404
   * otherwise), swaps in the view's dataset, and ANDs the view's preset scope into the
   * chart's own filter — so the chart can only ever read what the view exposes. Plain
   * dataset charts pass through unchanged.
   */
  /**
   * A chart reads EITHER a view the user can access (viewKey) or a raw dataset. Reading
   * a raw dataset directly is only for platform admins — everyone else must go through a
   * view, which is scoped to what they're allowed to see. This is the gate that keeps a
   * non-admin's personal charts inside their granted views.
   */
  private assertChartSource(spec: ChartSpec, user?: AuthenticatedUser) {
    if (spec.viewKey) return; // view access is enforced by resolveSpec
    if (!user?.permissions?.includes("admin:dashboards:manage")) {
      throw new ForbiddenException("Charts must be built on a View you can access.");
    }
  }

  private async resolveSpec(spec: ChartSpec, user?: AuthenticatedUser): Promise<ChartSpec> {
    if (!spec.viewKey) return spec;
    if (!user) throw new ForbiddenException("Sign-in required to read a view-based chart.");
    const view = await this.reports.viewScope(spec.viewKey, user);
    const merged = mergeScope(
      { conditions: view.baseConditions, logic: view.baseLogic },
      { conditions: spec.conditions, logic: spec.logic },
    );
    return {
      ...spec,
      dataset: view.datasetKey,
      conditions: merged.conditions,
      logic: merged.logic,
      // A "top N" view caps how many RECORDS a Table chart lists, matching what the view
      // itself shows. It no longer caps aggregated charts: a bar chart's groups are
      // summaries of the whole scope, not a row listing, so capping them would drop
      // categories rather than shorten a list.
      limit: view.rowLimit != null ? Math.min(spec.limit ?? view.rowLimit, view.rowLimit) : spec.limit,
    };
  }

  /** The catalog a spec queries against — its dataset, or findings by default. */
  private catalogFor(spec: ChartSpec) {
    return this.catalogs.forDataset(spec.dataset || DEFAULT_DATASET);
  }

  /** Grouping chart with at least one level — its matview holds the full breakdown. */
  private static isClauseChart(spec: ChartSpec): boolean {
    return spec.mode === "clause" && (spec.groupBy?.length ?? 0) > 0;
  }

  /**
   * Whether this chart stores the FULL per-level breakdown (so every drill level is a
   * re-aggregation of a tiny matview) — and if so, how its value is stored and recombined.
   * Null means the chart keeps a plain single-result matview and drills live.
   *
   * Any chart that drills qualifies: Grouping walks its group-by levels, Calculate Values
   * walks [X axis, ...drill-down]. A split-by chart keeps its series in the breakdown so
   * the base level can still show them (drill levels drop series, as they always have).
   * Only a measure that cannot be recombined exactly (see measureReaggParts) stays live.
   */
  private breakdownFor(
    spec: ChartSpec,
    catalog: any,
  ): { levels: string[]; parts: { valueCols: string; reaggExpr: string }; seriesKeys: string[] } | null {
    if (spec.chartType === "table") return null;
    if (DashboardService.isClauseChart(spec)) {
      return { levels: drillSequence(spec), parts: clauseMeasureParts(spec), seriesKeys: [] };
    }
    if (spec.mode === "compare") return null;
    if (!spec.drilldown?.length) return null; // nothing to drill into
    const parts = measureReaggParts(catalog.measures[spec.measure]?.expr ?? "");
    if (!parts) return null;
    const seriesKeys = (spec.groupBy?.length ? spec.groupBy : spec.series ? [spec.series] : [])
      .filter((k) => catalog.dimensions[k]);
    return { levels: drillSequence(spec), parts, seriesKeys };
  }

  /**
   * Matview builds currently running, keyed by widget. Every read that finds no matview
   * would otherwise kick off its own build, so opening a dashboard a few times while one
   * is running used to start several — each rebuilding the same view, competing for the
   * connection pool, and starving the very queries waiting on them. Callers join the
   * running build instead of starting another.
   */
  private readonly building = new Map<number, Promise<void>>();

  /** Start this chart's matview build, or hand back the one already running. */
  private buildMatview(widgetId: number, spec: ChartSpec): Promise<void> {
    const running = this.building.get(widgetId);
    if (running) return running;
    const build = this.syncChartMatview(widgetId, spec)
      .finally(() => this.building.delete(widgetId));
    this.building.set(widgetId, build);
    return build;
  }

  /**
   * Wait for this chart's matview, but never longer than `ms` — a caller that waits
   * forever would hold a request open for the whole build. On timeout the caller falls
   * back to querying the source; the build carries on and the next read gets it.
   */
  private async awaitMatview(widgetId: number, spec: ChartSpec, ms = 20_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.buildMatview(widgetId, spec),
        new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** (Re)build a chart's materialized view; best-effort — charts still work live if this fails. */
  private async syncChartMatview(widgetId: number, spec: ChartSpec): Promise<void> {
    if (spec.chartType === "table") return; // records list: no aggregation, no matview
    try {
      const catalog = await this.catalogFor(spec);
      // A drilling chart pre-aggregates EVERY level (g0..gN) so drilling reads the tiny
      // matview instead of the 10M-row source. Other charts store their single result set.
      const breakdown = this.breakdownFor(spec, catalog);
      const inline = breakdown
        ? buildBreakdownMatviewInline(spec, catalog, breakdown.levels, breakdown.parts, breakdown.seriesKeys)
        : buildAggregationInline(spec, catalog);
      if (inline) await this.repo.createChartMatview(widgetId, inline);
    } catch (e: any) {
      this.log.warn(`chart matview mv_chart_${widgetId} build failed: ${e?.message ?? e}`);
    }
  }

  /** Read a chart's data: matview → lazy-create matview → live aggregation. Never throws
   *  (a chart with an outdated/invalid spec returns [] so it can't break the dashboard). */
  private async chartData(widget: { id: number; config: any }, user?: AuthenticatedUser): Promise<any[]> {
    let spec: ChartSpec;
    try {
      spec = await this.resolveSpec(widget.config as ChartSpec, user);
    } catch (e: any) {
      // View revoked or unknown -> the chart simply shows nothing, never an error.
      this.log.warn(`chart ${widget.id} view unavailable (returning empty): ${e?.message ?? e}`);
      return [];
    }
    try {
      const catalog = await this.catalogFor(spec);
      // Table = records list: run the (non-aggregated) records query live.
      if (spec.chartType === "table") {
        const { sql, params } = buildRecordsChartQuery(spec, catalog);
        return await this.repo.runAggregation(sql, params);
      }
      const breakdown = this.breakdownFor(spec, catalog);
      try {
        // A drilling chart shows the FIRST level, re-aggregated from the breakdown matview
        // (the measure recombined from its stored components); everything else reads its
        // stored result set directly.
        if (breakdown) {
          if (await this.repo.breakdownTruncated(widget.id)) {
            // Too many level-combinations to pre-aggregate. Answer from the source —
            // slower, but a truncated breakdown would silently under-count.
            this.log.warn(`chart ${widget.id} breakdown too large to pre-aggregate; querying live`);
            const { sql, params } = buildAggregation(spec, catalog);
            return await this.repo.runAggregation(sql, params);
          }
          return await this.repo.aggregateChartMatview(
            widget.id, 0, [], resolveChartLimit(spec.limit), breakdown.parts.reaggExpr,
            breakdown.seriesKeys.length > 0);
        }
        return await this.repo.readChartMatview(widget.id);
      } catch {
        // No matview yet (new chart, or its build is still running). Serve the answer
        // LIVE right now and build the matview in the background — building it here
        // would stall the whole dashboard for minutes on a large table.
        void this.buildMatview(widget.id, spec);
        const { sql, params } = buildAggregation(spec, catalog);
        return await this.repo.runAggregation(sql, params);
      }
    } catch (e: any) {
      this.log.warn(`chart ${widget.id} data failed (returning empty): ${e?.message ?? e}`);
      return [];
    }
  }

  listForUser(user: AuthenticatedUser) {
    return this.repo.listAccessible(user.id, user.roles);
  }

  /** Legacy fixed-chart palette (still used by the seeded system dashboard). */
  dataSourceCatalog() {
    return DATA_SOURCE_CATALOG;
  }

  /** Archer-style builder catalog: X-axis fields, Y-axis measures, chart types, and the
   *  advanced filter fields + per-type operators (shared with the report filter builder). */
  async schema(datasetKey?: string, viewKey?: string, user?: AuthenticatedUser) {
    // Personalized Dashboard: the builder asks for a VIEW's schema. Resolve it to the
    // view's dataset (after checking access), so the field/measure catalog is the
    // dataset's, but the chart will be scoped to the view at query time.
    let view: { key: string; name: string } | undefined;
    let key = datasetKey || DEFAULT_DATASET;
    if (viewKey) {
      const scope = await this.reports.viewScope(viewKey, user!);
      key = scope.datasetKey;
      view = { key: scope.key, name: scope.name };
    }
    const [catalog, { fields, operators }, datasets] = await Promise.all([
      this.catalogs.forDataset(key),
      this.catalogs.fieldCatalogFor(key),
      this.catalogs.listDatasets(),
    ]);
    return {
      ...schemaCatalog(catalog),
      datasets, // so the builder can offer a dataset picker
      view,     // set when the schema is for a view (Personalized Dashboard)
      operators,
      filterFields: fields,
    };
  }

  /**
   * The chart designer previews on every keystroke, but a full aggregation over a
   * 10M-row table takes ~10s — long enough that the editor looks broken. For large
   * tables we aggregate a random TABLESAMPLE instead, which reads a fraction of the
   * pages and returns in well under a second. The shape of the chart (which groups
   * exist, their relative sizes) is what the designer is for; the saved chart always
   * runs the exact query. Returns null when the table is small enough to query fully.
   */
  private async sampledCatalog(catalog: any): Promise<{ catalog: any; scale: number } | null> {
    // SYSTEM sampling reads whole random pages, so cost tracks the fraction of the
    // table, not the row count. On the 10M-row / ~9GB findings table 0.2% (~20k rows)
    // returns in ~0.35s vs ~6s for the exact query, and group proportions are stable.
    const PREVIEW_TARGET_ROWS = 20_000;
    const rows = await this.repo.estimateRows(catalog.table);
    if (rows < 250_000) return null; // small table: the exact query is already fast

    const pct = Math.max(0.01, Math.min(100, (PREVIEW_TARGET_ROWS / rows) * 100));
    return {
      // TABLESAMPLE follows the alias, so only baseFrom changes; every
      // dimension/measure expression still refers to "f".
      catalog: { ...catalog, baseFrom: `FROM ${catalog.table} AS f TABLESAMPLE SYSTEM (${pct})` },
      scale: 100 / pct,
    };
  }

  /** Additive measures (count/sum) read low on a sample and must be scaled back up;
   *  avg is unbiased as-is, and min/max can't be corrected. */
  private static isAdditive(expr: string): boolean {
    return /\b(count|sum)\s*\(/i.test(expr);
  }

  /** Live preview: run an ad-hoc chart spec without saving it. */
  async previewQuery(specDto: ChartSpecDto, user?: AuthenticatedUser) {
    // Only admins may preview a raw-dataset chart; everyone else must go through a view.
    this.assertChartSource(specDto as ChartSpec, user);
    // Resolve a view-based spec first (validates access, applies the view's scope), so
    // the preview reflects exactly what the saved chart will show.
    const spec = await this.resolveSpec(specDto as ChartSpec, user);
    // The chart designer re-previews on every edit, and each preview is a full
    // aggregation over the dataset (seconds on a big table). Cache by the exact spec so
    // tweaking a title, flipping chart type back and forth, or re-opening a chart is
    // instant instead of re-scanning millions of rows.
    const cacheKey = `dash:preview:${JSON.stringify(spec)}`;
    const cached = await this.cache.getJson<{ rows: any[]; columns?: any[]; approximate?: boolean }>(cacheKey);
    if (cached) return cached;

    // Table = records list: return raw records + the resolved column set.
    const catalog = await this.catalogFor(spec as ChartSpec);
    let result: { rows: any[]; columns?: any[]; approximate?: boolean };
    if ((spec as ChartSpec).chartType === "table") {
      // A records list is already LIMITed, so it needs no sampling.
      const { sql, params, columns } = buildRecordsChartQuery(spec as ChartSpec, catalog);
      const rows = await this.repo.runAggregation(sql, params);
      result = { rows, columns: columns.map((c) => ({ key: c.key, label: c.label, numeric: !!c.numeric })) };
    } else {
      const sampled = await this.sampledCatalog(catalog);
      const { sql, params } = buildAggregation(spec as ChartSpec, sampled?.catalog ?? catalog);
      let rows = await this.repo.runAggregation(sql, params);
      if (sampled) {
        const measureExpr =
          catalog.measures[(spec as ChartSpec).measure]?.expr ?? catalog.measures.count.expr;
        if (DashboardService.isAdditive(measureExpr)) {
          rows = rows.map((r) => ({ ...r, y: Math.round(Number(r.y) * sampled.scale) }));
        }
      }
      result = { rows: [], approximate: !!sampled };
      Object.assign(result, DashboardService.previewTopGroups(rows, spec as ChartSpec, catalog));
    }
    await this.cache.setJson(cacheKey, result, 300); // 5 min; invalidated on sync
    return result;
  }

  /**
   * Trim a preview to the groups worth drawing. A level with thousands of values is what
   * the saved chart rolls up too — without this the designer draws every bar and locks
   * the browser up, which is the one thing a preview must never do.
   *
   * The tail is folded into a single "Other" bar when the measure allows it to be
   * recombined exactly from per-group results (count/sum are additive; min-of-mins and
   * max-of-maxes hold). An AVERAGE of averages is not the average, so rather than invent
   * a number the tail is reported as a count of omitted groups and the editor says so.
   */
  private static previewTopGroups(
    rows: any[], spec: ChartSpec, catalog: any,
  ): { rows: any[]; topGroups?: { shown: number; total: number; rolledUp: boolean } } {
    const hasSeries = rows.some((r) => r.series != null);
    if (rows.length <= CHART_TOP_GROUPS || hasSeries) return { rows };

    const sorted = [...rows].sort((a, b) => Number(b.y) - Number(a.y));
    const top = sorted.slice(0, CHART_TOP_GROUPS);
    const tail = sorted.slice(CHART_TOP_GROUPS);

    const agg = DashboardService.isClauseChart(spec)
      ? groupAggOf(spec)
      : /^\s*round\(\s*(\w+)/.exec(catalog.measures[spec.measure]?.expr ?? "")?.[1]
        ?? /^\s*(\w+)\s*\(/.exec(catalog.measures[spec.measure]?.expr ?? "")?.[1]
        ?? "";
    const vals = tail.map((r) => Number(r.y));
    const combine: Record<string, () => number> = {
      count: () => vals.reduce((s, v) => s + v, 0),
      sum: () => vals.reduce((s, v) => s + v, 0),
      min: () => Math.min(...vals),
      max: () => Math.max(...vals),
    };
    const fold = combine[agg];
    if (!fold) {
      // Not exactly recombinable (avg) — show the top groups and say what was left out.
      return { rows: top, topGroups: { shown: top.length, total: rows.length, rolledUp: false } };
    }
    return {
      rows: [...top, { x: `${OTHER_LABEL_PREFIX}${tail.length} more)`, y: fold() }],
      topGroups: { shown: top.length, total: rows.length, rolledUp: true },
    };
  }

  /**
   * Live preview of a DRILL step on an unsaved spec, so the designer can click through
   * the drill path before saving. There is no matview yet (that's built on save), so
   * this runs the drill query directly — against the same sample the base preview uses,
   * which is what keeps it sub-second on a 10M-row table.
   */
  async previewDrill(specDto: ChartSpecDto, steps: DrillStep[], user?: AuthenticatedUser) {
    this.assertChartSource(specDto as ChartSpec, user);
    const spec = await this.resolveSpec(specDto as ChartSpec, user);

    // Each step must follow the chart's own drill sequence — the same rule the saved
    // chart enforces, so the preview cannot show a path the real chart won't allow.
    const sequence = drillSequence(spec);
    steps.forEach((step, i) => {
      if (step.dimension !== sequence[i]) {
        throw new BadRequestException("Drill path does not match this chart's drill-down sequence");
      }
    });

    const cacheKey = `dash:preview:drill:${JSON.stringify({ spec, steps })}`;
    const cached = await this.cache.getJson<any>(cacheKey);
    if (cached) return cached;

    const catalog = await this.catalogFor(spec);
    const sampled = await this.sampledCatalog(catalog);
    const { sql, params, dimension, atLeaf } = buildDrill(spec, sampled?.catalog ?? catalog, steps);
    let rows = dimension ? await this.repo.runAggregation(sql, params) : [];
    if (sampled && rows.length) {
      const measureExpr = catalog.measures[spec.measure]?.expr ?? catalog.measures.count.expr;
      // A Grouping chart's avg/min/max roll-up is not additive, so it must not be scaled.
      const additive = DashboardService.isClauseChart(spec)
        ? ["count", "sum"].includes(groupAggOf(spec))
        : DashboardService.isAdditive(measureExpr);
      if (additive) rows = rows.map((r) => ({ ...r, y: Math.round(Number(r.y) * sampled.scale) }));
    }
    const result = { rows, dimension, atLeaf, approximate: !!sampled };
    await this.cache.setJson(cacheKey, result, 300);
    return result;
  }

  /** Validate a chart spec (throws 400 on bad keys), for either the aggregation or records path. */
  private async validateChartSpec(spec: ChartSpec): Promise<void> {
    const catalog = await this.catalogFor(spec);
    if (spec.chartType === "table") buildRecordsChartQuery(spec, catalog);
    else buildAggregation(spec, catalog);
  }

  // ---- Self-service builder (any user with dashboard:create) ----

  async createMine(user: AuthenticatedUser, dto: CreateMyDashboardDto) {
    const key = await this.uniqueKey(slugify(dto.name), user.id);
    const dashboard = await this.repo.create(key, dto.name, dto.description, 0, user.id);
    // Owner always sees their own dashboard; also grant an explicit user access row for clarity.
    await this.repo.grantAccess(dashboard.id, null, user.id);
    await this.invalidate(key);
    return this.repo.findById(dashboard.id);
  }

  async updateMine(key: string, user: AuthenticatedUser, dto: UpdateMyDashboardDto) {
    const dashboard = await this.mustOwn(key, user);
    await this.repo.update(dashboard.id, { name: dto.name, description: dto.description });
    await this.invalidate(key);
    return this.repo.findById(dashboard.id);
  }

  async deleteMine(key: string, user: AuthenticatedUser) {
    const dashboard = await this.mustOwn(key, user);
    // Drop per-chart matviews before the widgets cascade away (else they orphan).
    const widgets = await this.repo.listWidgets(dashboard.id, false);
    for (const w of widgets) {
      if (w.data_source === QUERY_BUILDER_SOURCE) await this.repo.dropChartMatview(w.id).catch(() => undefined);
    }
    await this.repo.deleteByIdCascade(dashboard.id);
    await this.invalidate(key);
  }

  async shareMine(key: string, user: AuthenticatedUser, dto: GrantAccessDto) {
    const dashboard = await this.mustOwn(key, user);
    if (!dto.roleId && !dto.userId) throw new BadRequestException("Provide roleId or userId");
    return this.repo.grantAccess(dashboard.id, dto.roleId ?? null, dto.userId ?? null);
  }

  // ---- Per-chart CRUD on an owned dashboard (the query-builder charts) ----

  async addChart(key: string, user: AuthenticatedUser, dto: AddChartWidgetDto) {
    const dashboard = await this.mustOwn(key, user);
    // A non-admin may only build charts on views they can access; admins may also use
    // raw datasets. Resolve after: for a view chart this checks view access + scope.
    this.assertChartSource(dto.spec as ChartSpec, user);
    const resolved = await this.resolveSpec(dto.spec as ChartSpec, user);
    await this.validateChartSpec(resolved);
    const existing = await this.repo.listWidgets(dashboard.id, false);
    const widget = await this.repo.addWidget(dashboard.id, {
      key: `chart_${Date.now()}`,
      title: dto.title,
      widget_type: dto.spec.chartType,
      data_source: QUERY_BUILDER_SOURCE,
      sort_order: existing.length,
      is_active: true,
      config: dto.spec as unknown as Record<string, unknown>,
    });
    // Build the matview in the BACKGROUND. It aggregates the whole table, which on a
    // large dataset takes minutes — awaiting it here holds the HTTP request open until
    // the gateway kills it (Azure App Service cuts off at 230s), so saving a chart
    // appears to fail. The chart works immediately either way: until the matview
    // exists, chartData() falls back to a live aggregation.
    void this.buildMatview(widget.id, resolved);
    await this.invalidate(key);
    return widget;
  }

  async updateChart(key: string, widgetId: number, user: AuthenticatedUser, dto: UpdateChartWidgetDto) {
    await this.mustOwn(key, user);
    if (dto.spec) this.assertChartSource(dto.spec as ChartSpec, user);
    const resolved = dto.spec ? await this.resolveSpec(dto.spec as ChartSpec, user) : undefined;
    if (resolved) await this.validateChartSpec(resolved);
    await this.repo.updateWidget(widgetId, {
      title: dto.title,
      widget_type: dto.spec?.chartType,
      config: dto.spec as unknown as Record<string, unknown> | undefined,
      sort_order: dto.sortOrder,
    });
    if (resolved) void this.buildMatview(widgetId, resolved); // spec changed -> rebuild in background
    await this.invalidate(key);
    return this.repo.listWidgets((await this.repo.findByKey(key))!.id, false);
  }

  async removeChart(key: string, widgetId: number, user: AuthenticatedUser) {
    await this.mustOwn(key, user);
    await this.repo.deleteWidget(widgetId);
    await this.repo.dropChartMatview(widgetId).catch(() => undefined);
    await this.invalidate(key);
  }

  /**
   * Drill one level down a chart. Only needs read access to the dashboard; the
   * drill path is validated against the widget's own stored spec, so viewers of a
   * shared dashboard can drill but cannot alter what's queried.
   */
  async drill(key: string, widgetId: number, user: AuthenticatedUser, steps: DrillStep[]) {
    const dashboard = await this.repo.findAccessibleByKey(key, user.id, user.roles);
    if (!dashboard) throw new ForbiddenException("You do not have access to this dashboard");
    const widget = (await this.repo.listWidgets(dashboard.id, false)).find((w) => w.id === widgetId);
    if (!widget || widget.data_source !== QUERY_BUILDER_SOURCE) {
      throw new NotFoundException("Chart not found");
    }
    const spec = await this.resolveSpec(widget.config as unknown as ChartSpec, user);

    const catalog = await this.catalogFor(spec);

    // Fast path: a drilling chart's matview holds every level, so drilling is a tiny
    // re-aggregation of it (~ms) rather than a fresh scan of the 10M-row source, which
    // costs seconds at the first level and tens of seconds deeper in.
    const breakdown = this.breakdownFor(spec, catalog);
    if (breakdown) {
      const sequence = breakdown.levels;
      steps.forEach((step, i) => {
        if (step.dimension !== sequence[i]) {
          throw new BadRequestException("Drill path does not match this chart's drill-down sequence");
        }
      });
      const level = steps.length;
      const levelDim = sequence[level] ?? null;
      if (!levelDim) return { rows: [], dimension: null, atLeaf: true };

      /** Read this level from the breakdown; null = incomplete, so it must not be used. */
      const fromMatview = async () => {
        // An incomplete breakdown would under-count every level, so fall through to the
        // live query (slower, correct) rather than serve it.
        if (await this.repo.breakdownTruncated(widgetId)) return null;
        const rows = await this.repo.aggregateChartMatview(widgetId, level, steps.map((s) => s.value), resolveChartLimit(spec.limit), breakdown.parts.reaggExpr);
        return { rows, dimension: levelDim, atLeaf: level + 1 >= sequence.length };
      };

      try {
        const hit = await fromMatview();
        if (hit) return hit;
      } catch {
        // No matview yet — the chart was only just saved, so its build is still running.
        // Waiting for that build is far cheaper than drilling the source table (which
        // costs seconds at the first level and tens of seconds deeper in), and it leaves
        // the chart fast from here on instead of paying that price on every click.
        try {
          await this.awaitMatview(widgetId, spec);
          const hit = await fromMatview();
          if (hit) return hit;
        } catch (e: any) {
          // Build failed or is still running past the wait — answer live below.
          this.log.warn(`drill matview miss for ${widgetId}, live fallback: ${e?.message ?? e}`);
        }
      }
    }

    const { sql, params, dimension, atLeaf } = buildDrill(spec, catalog, steps);
    const rows = dimension ? await this.repo.runAggregation(sql, params) : [];
    return { rows, dimension, atLeaf };
  }

  /** Raw records behind a chart's full drill path (the leaf-level table). */
  async chartRecords(key: string, widgetId: number, user: AuthenticatedUser, steps: DrillStep[]) {
    const dashboard = await this.repo.findAccessibleByKey(key, user.id, user.roles);
    if (!dashboard) throw new ForbiddenException("You do not have access to this dashboard");
    const widget = (await this.repo.listWidgets(dashboard.id, false)).find((w) => w.id === widgetId);
    if (!widget || widget.data_source !== QUERY_BUILDER_SOURCE) {
      throw new NotFoundException("Chart not found");
    }
    const spec = await this.resolveSpec(widget.config as unknown as ChartSpec, user);
    // Each step's dimension must follow the chart's own drill sequence (the group-by
    // levels in Grouping mode, else the base dimension + drill-down path).
    const sequence = drillSequence(spec);
    steps.forEach((step, i) => {
      if (step.dimension !== sequence[i]) {
        throw new BadRequestException("Drill path does not match this chart's drill-down sequence");
      }
    });
    const { sql, params } = buildRecordsQuery(spec, await this.catalogFor(spec), steps);
    const rows = await this.repo.runAggregation(sql, params);
    return { rows };
  }

  private async mustOwn(key: string, user: AuthenticatedUser) {
    const dashboard = await this.repo.findByKey(key);
    if (!dashboard) throw new NotFoundException("Dashboard not found");
    const isOwner = dashboard.owner_user_id === user.id;
    const isAdmin = user.permissions.includes("admin:dashboards:manage");
    if (!isOwner && !isAdmin) throw new ForbiddenException("You can only modify your own dashboards");
    return dashboard;
  }

  private async uniqueKey(base: string, userId: number): Promise<string> {
    let candidate = `${base}-u${userId}`;
    let n = 1;
    while (await this.repo.findByKey(candidate)) {
      candidate = `${base}-u${userId}-${n++}`;
    }
    return candidate;
  }

  async getWithData(key: string, user: AuthenticatedUser) {
    const dashboard = await this.repo.findAccessibleByKey(key, user.id, user.roles);
    if (!dashboard) throw new ForbiddenException("You do not have access to this dashboard");

    const widgets = await this.repo.listWidgets(dashboard.id);
    // View-based charts resolve per the viewer's own access, so their data must not be
    // shared through the dashboard-wide cache (a viewer without access to a view would
    // otherwise be served another user's rows). Cache only plain dashboards.
    const hasViewChart = widgets.some((w) => (w.config as { viewKey?: string } | undefined)?.viewKey);
    const cacheKey = `dash:${key}:data`;
    if (!hasViewChart) {
      const cached = await this.cache.getJson<Record<string, any[]>>(cacheKey);
      if (cached) return { dashboard, widgets, data: cached };
    }

    // Run every widget's query concurrently; user-built charts read a per-chart
    // materialized view (instant, row-count-independent) with a live fallback.
    const entries = await Promise.all(
      widgets.map(async (widget): Promise<[string, any[]]> => {
        if (widget.data_source === QUERY_BUILDER_SOURCE) {
          return [widget.key, await this.chartData(widget, user)];
        }
        // Legacy fixed-source widgets: tolerate a missing data source (return empty).
        try {
          return [widget.key, await this.repo.runWidgetData(widget.data_source)];
        } catch (e: any) {
          this.log.warn(`widget ${widget.id} source '${widget.data_source}' failed: ${e?.message ?? e}`);
          return [widget.key, []];
        }
      }),
    );
    const data: Record<string, any[]> = Object.fromEntries(entries);
    if (!hasViewChart) await this.cache.setJson(cacheKey, data);
    return { dashboard, widgets, data };
  }

  // ---- Admin ----

  listAll() {
    return this.repo.listAll();
  }

  async create(dto: CreateDashboardDto) {
    return this.repo.create(dto.key, dto.name, dto.description, dto.sortOrder ?? 0);
  }

  async update(id: number, dto: UpdateDashboardDto) {
    const updated = await this.repo.update(id, {
      name: dto.name,
      description: dto.description,
      is_active: dto.isActive,
      sort_order: dto.sortOrder,
    });
    if (!updated) throw new NotFoundException("Dashboard not found");
    await this.invalidate(updated.key);
    return updated;
  }

  async addWidget(dashboardId: number, dto: CreateWidgetDto) {
    const dashboard = await this.repo.findById(dashboardId);
    if (!dashboard) throw new NotFoundException("Dashboard not found");
    const widget = await this.repo.addWidget(dashboardId, {
      key: dto.key,
      title: dto.title,
      widget_type: dto.widgetType,
      data_source: dto.dataSource,
      sort_order: dto.sortOrder ?? 0,
      is_active: true,
      config: dto.config ?? {},
    });
    await this.invalidate(dashboard.key);
    return widget;
  }

  async updateWidget(dashboardId: number, widgetId: number, dto: UpdateWidgetDto) {
    const dashboard = await this.repo.findById(dashboardId);
    if (!dashboard) throw new NotFoundException("Dashboard not found");
    await this.repo.updateWidget(widgetId, {
      title: dto.title,
      widget_type: dto.widgetType,
      data_source: dto.dataSource,
      sort_order: dto.sortOrder,
      is_active: dto.isActive,
      config: dto.config,
    });
    await this.invalidate(dashboard.key);
    return this.repo.listWidgets(dashboardId, false);
  }

  async deleteWidget(dashboardId: number, widgetId: number) {
    const dashboard = await this.repo.findById(dashboardId);
    if (!dashboard) throw new NotFoundException("Dashboard not found");
    await this.repo.deleteWidget(widgetId);
    await this.invalidate(dashboard.key);
  }

  listAccess(dashboardId: number) {
    return this.repo.listAccess(dashboardId);
  }

  grantAccess(dashboardId: number, dto: GrantAccessDto) {
    if (!dto.roleId && !dto.userId) {
      throw new NotFoundException("Provide either roleId or userId");
    }
    return this.repo.grantAccess(dashboardId, dto.roleId ?? null, dto.userId ?? null);
  }

  revokeAccess(accessId: number) {
    return this.repo.revokeAccess(accessId);
  }

  private async invalidate(dashboardKey: string) {
    await this.cache.invalidatePrefix(`dash:${dashboardKey}`);
  }
}
