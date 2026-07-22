import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from "@nestjs/common";
import { Response } from "express";
import { AuthenticatedUser } from "../auth/jwt-payload.interface";
import { CacheService } from "../cache/cache.service";
import { ExportService } from "./export.service";
import { buildExpressionWhere, FilterField } from "./filterable-fields";
import { CatalogService } from "../datasets/catalog.service";
import { FindingsFilter, FindingsQuery, ReportsRepository } from "./reports.repository";
import { ReportContext, ReportRow } from "./report.entity";
import {
  CreateReportDto,
  GrantReportAccessDto,
  SaveViewDto,
  UpsertColumnDto,
  UpsertFilterDto,
  UpdateReportDto,
} from "./dto/report.dto";

const DEFAULT_DATASET = "archer-findings";

@Injectable()
export class ReportsService implements OnApplicationBootstrap {
  private readonly log = new Logger(ReportsService.name);

  /** Warm the default register counts shortly after boot so the first login is instant. */
  onApplicationBootstrap() {
    setTimeout(() => {
      this.warmupCounts()
        .then(() => this.log.log("report counts pre-warmed"))
        .catch((e) => this.log.warn(`report warm-up skipped: ${e?.message ?? e}`));
    }, 4000);
  }

  constructor(
    private readonly repo: ReportsRepository,
    private readonly cache: CacheService,
    private readonly exportSvc: ExportService,
    private readonly catalogs: CatalogService,
  ) {}

  listForUser(user: AuthenticatedUser) {
    return this.repo.listAccessible(user.id, user.roles);
  }

  /**
   * A view's dataset + preset scope, for building a chart on top of it (Personalized
   * Dashboards). Throws 403/404 if the user can't access the view — so a chart can
   * never read a view its owner isn't allowed to see. row_limit is also returned so a
   * view that shows "top N" caps the chart's data too.
   */
  async viewScope(key: string, user: AuthenticatedUser) {
    const report = await this.mustBeAccessible(key, user);
    return {
      key: report.key,
      name: report.name,
      datasetKey: report.dataset_key || DEFAULT_DATASET,
      baseConditions: report.base_conditions ?? [],
      baseLogic: report.base_logic ?? null,
      rowLimit: report.row_limit ?? null,
    };
  }

  async getConfig(key: string, user: AuthenticatedUser) {
    const report = await this.mustBeAccessible(key, user);
    const [columns, filters] = await Promise.all([
      this.repo.listColumns(report.id),
      this.repo.listFilters(report.id),
    ]);
    return { report, columns, filters };
  }

  async findings(key: string, user: AuthenticatedUser, q: FindingsQuery) {
    const report = await this.mustBeAccessible(key, user);
    const ctx = await this.contextFor(report);
    return this.findingsData(key, ctx, { ...q, ...this.scopeOf(report) }, report.row_limit);
  }

  /**
   * "Rows to show = top N": the view exposes only the first N rows of its sort order,
   * so we shrink the page window rather than filtering in SQL. A page starting at or
   * past N asks for LIMIT 0 (valid, returns nothing) and a page straddling N is
   * truncated to end exactly on it — so paging, the row count and exports all agree
   * on the same N rows.
   */
  private capPage(q: FindingsQuery, rowLimit: number | null | undefined): FindingsQuery {
    if (!rowLimit || rowLimit <= 0) return q;
    const offset = (q.page - 1) * q.size;
    return { ...q, size: Math.max(0, Math.min(q.size, rowLimit - offset)) };
  }

  /** A view's preset scope, applied to every query/export of that view. */
  private scopeOf(report: { base_conditions?: any[] | null; base_logic?: string | null }) {
    return { baseConditions: report.base_conditions ?? [], baseLogic: report.base_logic ?? null };
  }

  /**
   * The SQL context for a report — built from its dataset's catalog. This is what
   * makes the register/views run against ANY dataset: base table, searchable and
   * sortable columns, filter fields and the SELECT column list all come from the
   * dataset, not a hardcoded findings shape.
   */
  private async contextFor(report: ReportRow): Promise<ReportContext> {
    const catalog = await this.catalogs.forDataset(report.dataset_key || DEFAULT_DATASET);
    const configured = await this.repo.listColumns(report.id);
    const keys: string[] = configured.map((c) => c.key).filter((k) => catalog.recordFields[k]);
    if (!keys.length) keys.push(...catalog.defaultRecordCols.filter((k) => catalog.recordFields[k]));
    if (!keys.includes("record_id") && catalog.recordFields["record_id"]) keys.unshift("record_id");
    return {
      table: catalog.table,
      baseFrom: catalog.baseFrom,
      searchable: catalog.searchable,
      globalSearch: catalog.globalSearch,
      sortable: catalog.sortable,
      filterFields: catalog.filterFields,
      selectCols: keys.map((k) => ({ key: k, expr: catalog.recordFields[k].expr })),
      defaultSortExpr: catalog.defaultSort ? `f.${catalog.defaultSort}` : "f.record_id",
    };
  }

  /** The export column set (key + label) for a report, from its dataset catalog. */
  private async exportColumnsFor(report: ReportRow): Promise<{ key: string; label: string }[]> {
    const catalog = await this.catalogs.forDataset(report.dataset_key || DEFAULT_DATASET);
    const ctx = await this.contextFor(report);
    return ctx.selectCols.map((c) => ({ key: c.key, label: catalog.recordFields[c.key]?.label ?? c.key }));
  }

  /**
   * Page rows (fast, index-served) + matching-row count. The count is the expensive
   * part over big tables, so it's cached with a longer TTL keyed by the filter only —
   * it changes only when data does (on sync). The page is cached briefly.
   */
  private async findingsData(key: string, ctx: ReportContext, q: FindingsQuery, rowLimit?: number | null) {
    // Only the SQL page window is capped. The response still reports the size the
    // caller asked for, because the client derives its page count from total/size —
    // handing back a shrunken last-page size would inflate that.
    const pageQuery = this.capPage(q, rowLimit);
    const respKey = `report:${key}:data:${JSON.stringify(pageQuery)}`;
    const cached = await this.cache.getJson<{ total: number; totalCapped?: boolean; totalEstimated?: boolean; page: number; size: number; rows: any[] }>(respKey);
    if (cached) return cached;

    const countKey = `report:${key}:count:${JSON.stringify({ c: q.conditions ?? [], l: q.logic ?? null, s: q.search ?? "", cf: q.colFilters ?? {}, bc: q.baseConditions ?? [], bl: q.baseLogic ?? null })}`;
    const getCount = async () => {
      const cachedCount = await this.cache.getJson<{ total: number; capped: boolean; estimated?: boolean }>(countKey);
      if (cachedCount != null) return cachedCount;
      const t = await this.repo.countFindings(ctx, q);
      await this.cache.setJson(countKey, t, 1800); // 30 min; invalidated on sync
      return t;
    };

    // For a search, the count (always fast — bounded at 10k) tells us whether the match
    // set is small: if so the page must filter-before-sort to avoid a planner trap, so
    // we compute count first and pass that hint. Without a search, count and page are
    // independent and run in parallel.
    const searching = !!(q.search ?? "").trim() || Object.values(q.colFilters ?? {}).some((v) => (v ?? "").trim());
    let count: { total: number; capped: boolean; estimated?: boolean };
    let rows: any[];
    if (searching) {
      count = await getCount();
      rows = pageQuery.size > 0 ? await this.repo.pageFindings(ctx, pageQuery, !count.capped) : [];
    } else {
      [count, rows] = await Promise.all([
        getCount(),
        pageQuery.size > 0 ? this.repo.pageFindings(ctx, pageQuery) : Promise.resolve([]),
      ]);
    }
    // A "top N" view never has more than N rows, so report N as the total — otherwise
    // the pager would offer pages the view will never serve.
    const limited = rowLimit && rowLimit > 0 && count.total > rowLimit;
    const result = {
      total: limited ? rowLimit! : count.total,
      totalCapped: limited ? false : count.capped,
      totalEstimated: limited ? false : (count.estimated ?? false),
      page: q.page,
      size: q.size,
      rows,
    };
    await this.cache.setJson(respKey, result, 60);
    return result;
  }

  /** Pre-warm each report's default (unfiltered) count so the first user load is instant. */
  async warmupCounts() {
    const reports = await this.repo.listAll();
    for (const r of reports) {
      if (!r.is_active) continue;
      const ctx = await this.contextFor(r).catch(() => null);
      if (!ctx) continue;
      await this.findingsData(r.key, ctx, {
        page: 1, size: 50, conditions: [], logic: undefined, sort: undefined, order: undefined,
        ...this.scopeOf(r),
      }).catch(() => undefined);
    }
  }

  async filterOptions(key: string, user: AuthenticatedUser) {
    const report = await this.mustBeAccessible(key, user);
    const { fields } = await this.catalogs.fieldCatalogFor(report.dataset_key || DEFAULT_DATASET);
    const out: Record<string, string[]> = {};
    for (const f of fields) if (f.options?.length) out[f.key] = f.options;
    return out;
  }

  /** Advanced-filter field catalog for this view's dataset: fields + options + operators. */
  async getFields(key: string, user: AuthenticatedUser) {
    const report = await this.mustBeAccessible(key, user);
    return this.catalogs.fieldCatalogFor(report.dataset_key || DEFAULT_DATASET);
  }

  async exportCsv(key: string, user: AuthenticatedUser, res: Response, filters: FindingsFilter) {
    const report = await this.mustBeAccessible(key, user);
    const [ctx, columns] = await Promise.all([this.contextFor(report), this.exportColumnsFor(report)]);
    filters = { ...filters, ...this.scopeOf(report) };
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=${key}_export.csv`);
    res.write(columns.map((c) => c.label).join(",") + "\r\n");
    const csvCell = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = Array.isArray(v) ? v.join("; ") : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for await (const batch of this.capStream(this.repo.streamFindings(ctx, filters), report.row_limit)) {
      const lines = batch
        .map((r: any) => columns.map((c) => csvCell(r[c.key])).join(","))
        .join("\r\n");
      res.write(lines + "\r\n");
    }
    res.end();
  }

  async exportExcel(key: string, user: AuthenticatedUser, res: Response, filters: FindingsFilter) {
    const report = await this.mustBeAccessible(key, user);
    const [ctx, columns] = await Promise.all([this.contextFor(report), this.exportColumnsFor(report)]);
    await this.exportSvc.streamExcel(
      res, `${key}_export.xlsx`, columns,
      this.capStream(this.repo.streamFindings(ctx, { ...filters, ...this.scopeOf(report) }), report.row_limit),
    );
  }

  async exportPdf(key: string, user: AuthenticatedUser, res: Response, filters: FindingsFilter) {
    const report = await this.mustBeAccessible(key, user);
    const [ctx, columns] = await Promise.all([this.contextFor(report), this.exportColumnsFor(report)]);
    await this.exportSvc.streamPdf(
      res, `${key}_export.pdf`, report.name, columns,
      this.capStream(this.repo.streamFindings(ctx, { ...filters, ...this.scopeOf(report) }), report.row_limit),
    );
  }

  // ---- Record Views (admin) ----

  /** Datasets a view can be built on (for the Data source picker). */
  listDatasets() {
    return this.catalogs.listDatasets();
  }

  /** A dataset's filter fields + record columns, for building a view on it. */
  async datasetSchema(datasetKey: string) {
    const [catalog, fieldCatalog] = await Promise.all([
      this.catalogs.forDataset(datasetKey),
      this.catalogs.fieldCatalogFor(datasetKey),
    ]);
    return {
      ...fieldCatalog,
      recordColumns: Object.values(catalog.recordFields).map((c) => ({ key: c.key, label: c.label, numeric: !!c.numeric })),
    };
  }

  /** Live "this view matches N records" while an admin builds the rule. */
  async matchCount(datasetKey: string, conditions: any[], logic?: string | null) {
    const catalog = await this.catalogs.forDataset(datasetKey);
    const ctx: ReportContext = {
      table: catalog.table,
      baseFrom: catalog.baseFrom, searchable: catalog.searchable, globalSearch: catalog.globalSearch,
      sortable: catalog.sortable,
      filterFields: catalog.filterFields, selectCols: [], defaultSortExpr: "f.record_id",
    };
    const { total, capped } = await this.repo.countFindings(ctx, {
      page: 1, size: 1, conditions: conditions ?? [], logic: logic ?? undefined,
    });
    return { total, capped };
  }

  listViews() {
    return this.repo.listViews();
  }

  /**
   * Stop a row stream once the view's "top N" is reached, so an export of a limited
   * view contains exactly the rows the user can see in it — not the whole match set.
   */
  private async *capStream(source: AsyncGenerator<any[]>, rowLimit: number | null): AsyncGenerator<any[]> {
    if (!rowLimit || rowLimit <= 0) {
      yield* source;
      return;
    }
    let sent = 0;
    for await (const batch of source) {
      const room = rowLimit - sent;
      if (room <= 0) return;
      yield batch.length > room ? batch.slice(0, room) : batch;
      sent += Math.min(batch.length, room);
      if (sent >= rowLimit) return;
    }
  }

  /** Reject a broken preset filter at save time rather than at every user query. */
  private validateScope(conditions: any[], logic: string | null | undefined, fields: Record<string, FilterField>) {
    buildExpressionWhere(conditions ?? [], logic ?? null, 0, fields); // throws 400 on bad field/operator/logic
  }

  private slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "view";
  }

  async createView(dto: SaveViewDto) {
    const datasetKey = dto.datasetKey || DEFAULT_DATASET;
    const catalog = await this.catalogs.forDataset(datasetKey); // validates dataset + gives table/fields
    this.validateScope(dto.baseConditions ?? [], dto.baseLogic, catalog.filterFields);
    let key = this.slug(dto.name);
    for (let n = 1; await this.repo.findByKeyRaw(key); n++) key = `${this.slug(dto.name)}-${n}`;
    const view = await this.repo.createView({
      key,
      name: dto.name,
      description: dto.description,
      datasetKey,
      dataSource: catalog.table,
      baseConditions: dto.baseConditions ?? [],
      baseLogic: dto.baseLogic,
      rowLimit: dto.rowLimit ?? null,
      sortOrder: dto.sortOrder,
    });
    await this.applyViewParts(view.id, dto);
    await this.invalidate(view.key);
    return view;
  }

  async updateView(id: number, dto: SaveViewDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException("View not found");
    const catalog = await this.catalogs.forDataset(existing.dataset_key || DEFAULT_DATASET);
    this.validateScope(dto.baseConditions ?? [], dto.baseLogic, catalog.filterFields);
    const view = await this.repo.updateView(id, {
      name: dto.name,
      description: dto.description,
      baseConditions: dto.baseConditions,
      baseLogic: dto.baseLogic,
      rowLimit: dto.rowLimit ?? null,
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
    });
    if (!view) throw new NotFoundException("View not found");
    await this.applyViewParts(id, dto);
    await this.invalidate(view.key);
    return view;
  }

  private async applyViewParts(id: number, dto: SaveViewDto) {
    if (dto.columns) await this.repo.setColumns(id, dto.columns);
    if (dto.roleIds) await this.repo.setAccessRoles(id, dto.roleIds);
  }

  async deleteView(id: number) {
    const view = await this.repo.findById(id);
    if (!view) throw new NotFoundException("View not found");
    if (view.key === "findings-register") {
      throw new BadRequestException("The full Findings Register cannot be deleted");
    }
    await this.repo.deleteView(id);
    await this.invalidate(view.key);
  }

  /** A view's cached pages/counts must go when its scope, columns or access change. */
  private invalidate(key: string) {
    return this.cache.invalidatePrefix(`report:${key}`);
  }

  // ---- Admin ----

  listAll() {
    return this.repo.listAll();
  }

  create(dto: CreateReportDto) {
    return this.repo.create(dto.key, dto.name, dto.description, dto.dataSource ?? "fact_findings");
  }

  async update(id: number, dto: UpdateReportDto) {
    const updated = await this.repo.update(id, {
      name: dto.name,
      description: dto.description,
      is_active: dto.isActive,
    });
    if (!updated) throw new NotFoundException("Report not found");
    return updated;
  }

  async upsertColumn(reportId: number, dto: UpsertColumnDto) {
    if (!(await this.repo.findById(reportId))) throw new NotFoundException("Report not found");
    return this.repo.upsertColumn(reportId, {
      key: dto.key,
      label: dto.label,
      sortable: dto.sortable ?? true,
      is_default_visible: dto.isDefaultVisible ?? true,
      sort_order: dto.sortOrder ?? 0,
    });
  }

  deleteColumn(columnId: number) {
    return this.repo.deleteColumn(columnId);
  }

  async upsertFilter(reportId: number, dto: UpsertFilterDto) {
    if (!(await this.repo.findById(reportId))) throw new NotFoundException("Report not found");
    return this.repo.upsertFilter(reportId, {
      key: dto.key,
      label: dto.label,
      filter_type: dto.filterType,
      source: dto.source ?? null,
      sort_order: dto.sortOrder ?? 0,
    });
  }

  deleteFilter(filterId: number) {
    return this.repo.deleteFilter(filterId);
  }

  listAccess(reportId: number) {
    return this.repo.listAccess(reportId);
  }

  grantAccess(reportId: number, dto: GrantReportAccessDto) {
    return this.repo.grantAccess(reportId, dto.roleId ?? null, dto.userId ?? null);
  }

  revokeAccess(accessId: number) {
    return this.repo.revokeAccess(accessId);
  }

  private async mustBeAccessible(key: string, user: AuthenticatedUser) {
    const report = await this.repo.findAccessibleByKey(key, user.id, user.roles);
    if (!report) throw new ForbiddenException("You do not have access to this report");
    return report;
  }
}
