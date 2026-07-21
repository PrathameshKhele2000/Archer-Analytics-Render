import { BadRequestException, Injectable } from "@nestjs/common";
import { Response } from "express";
import { CacheService } from "../cache/cache.service";
import { DbService } from "../database/db.service";
import { ExportService } from "../reports/export.service";
import { ReportContext } from "../reports/report.entity";
import { FindingsFilter, FindingsQuery, ReportsRepository } from "../reports/reports.repository";
import { CatalogService } from "./catalog.service";

export interface DatasetSummary {
  key: string;
  name: string;
  description: string | null;
  /** Where the rows come from in the Archer reporting feed (null = imported/manual). */
  sourceTable: string | null;
  /** The Postgres table the mapping writes into. */
  targetTable: string;
  columnCount: number;
  rowCount: number;
  /** True when rowCount is a planner estimate rather than an exact count. */
  rowCountEstimated: boolean;
  lastSyncedAt: string | null;
}

/**
 * Read-only browsing of a registered dataset: every mapped column, every row.
 *
 * The Records tab shows *curated views* — an admin picks which columns a view exposes
 * and can pin a preset scope onto it. This is the raw counterpart: once a data source
 * has been mapped, this shows exactly what landed in the table, with nothing hidden.
 * It reuses the same catalog and paging engine as reports, so a 10M-row dataset pages
 * and searches at the same speed.
 */
@Injectable()
export class DatasetBrowseService {
  constructor(
    private readonly db: DbService,
    private readonly catalogs: CatalogService,
    private readonly repo: ReportsRepository,
    private readonly cache: CacheService,
    private readonly exportSvc: ExportService,
  ) {}

  /** Active datasets with enough detail to pick one, cheap enough to load on tab open. */
  async list(): Promise<DatasetSummary[]> {
    const { rows } = await this.db.query<{
      key: string; name: string; description: string | null;
      source_table: string | null; target_table: string; table_exists: boolean;
    }>(
      `SELECT d.key, d.name, d.description, d.source_table, d.target_table,
              to_regclass(d.target_table) IS NOT NULL AS table_exists
         FROM dataset d
        WHERE d.is_active
        ORDER BY d.is_protected DESC, d.name`,
    );

    const lastSynced = await this.lastSyncedAt();
    return Promise.all(
      rows.map(async (d) => {
        const counted = d.table_exists ? await this.countRows(d.target_table) : { total: 0, estimated: false };
        // Column count comes from the catalog, not a COUNT over dataset_field: the
        // catalog always exposes record_id, and a dataset may also declare a field of
        // that name (which collapses into the same column). Counting rows in the
        // registry instead would show one more column than the table actually renders.
        const catalog = await this.catalogs.forDataset(d.key).catch(() => null);
        return {
          key: d.key,
          name: d.name,
          description: d.description,
          sourceTable: d.source_table,
          targetTable: d.target_table,
          columnCount: catalog ? Object.keys(catalog.recordFields).length : 0,
          rowCount: counted.total,
          rowCountEstimated: counted.estimated,
          lastSyncedAt: lastSynced,
        };
      }),
    );
  }

  /**
   * Row count for the card. An exact count(*) scans the whole table (~6s at 10M rows)
   * and this runs for every dataset on tab open, so use the planner's estimate once a
   * table is big enough for the difference to matter.
   */
  private async countRows(table: string): Promise<{ total: number; estimated: boolean }> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::regclass`,
      [table],
    );
    const estimate = Number(rows[0]?.n ?? -1);
    if (estimate > 100_000) return { total: estimate, estimated: true };
    // Small table (or never analyzed): an exact count is cheap and worth showing.
    const exact = await this.db.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table}`);
    return { total: Number(exact.rows[0].n), estimated: false };
  }

  private async lastSyncedAt(): Promise<string | null> {
    const { rows } = await this.db.query<{ finished_at: string | null }>(
      `SELECT finished_at FROM sync_history WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`,
    );
    return rows[0]?.finished_at ?? null;
  }

  /**
   * The SQL context for browsing a dataset: EVERY mapped column is selected, in
   * registry order. This is the one difference from a report view, which selects only
   * its configured columns.
   */
  private async contextFor(key: string): Promise<ReportContext> {
    const catalog = await this.catalogs.forDataset(key);
    const keys = Object.keys(catalog.recordFields);
    if (!keys.length) throw new BadRequestException(`Dataset '${key}' has no mapped columns yet`);
    return {
      table: catalog.table,
      baseFrom: catalog.baseFrom,
      searchable: catalog.searchable,
      sortable: catalog.sortable,
      filterFields: catalog.filterFields,
      selectCols: keys.map((k) => ({ key: k, expr: catalog.recordFields[k].expr })),
      defaultSortExpr: catalog.defaultSort ? `f.${catalog.defaultSort}` : "f.record_id",
    };
  }

  /** Column list + filter catalog, so the table can render headers and a filter builder. */
  async schema(key: string) {
    const [catalog, fieldCatalog] = await Promise.all([
      this.catalogs.forDataset(key),
      this.catalogs.fieldCatalogFor(key),
    ]);
    return {
      key: catalog.key,
      name: catalog.name,
      table: catalog.table,
      defaultSort: catalog.defaultSort ?? "record_id",
      columns: Object.values(catalog.recordFields).map((c) => ({
        key: c.key,
        label: c.label,
        numeric: !!c.numeric,
        // Every record field has a sortable expression; searchable ones get a filter box.
        sortable: !!catalog.sortable[c.key],
        searchable: !!catalog.searchable[c.key],
      })),
      operators: fieldCatalog.operators,
      fields: fieldCatalog.fields,
    };
  }

  /** One page of rows, with the count cached separately (it only changes on sync). */
  async data(key: string, q: FindingsQuery) {
    const ctx = await this.contextFor(key);
    const respKey = `report:dsbrowse:${key}:${JSON.stringify(q)}`;
    const cached = await this.cache.getJson<any>(respKey);
    if (cached) return cached;

    const countKey = `report:dsbrowse:${key}:count:${JSON.stringify({
      c: q.conditions ?? [], l: q.logic ?? null, s: q.search ?? "", cf: q.colFilters ?? {},
    })}`;
    const [count, rows] = await Promise.all([
      (async () => {
        const hit = await this.cache.getJson<{ total: number; capped: boolean; estimated?: boolean }>(countKey);
        if (hit != null) return hit;
        const t = await this.repo.countFindings(ctx, q);
        await this.cache.setJson(countKey, t, 1800);
        return t;
      })(),
      this.repo.pageFindings(ctx, q),
    ]);

    const result = {
      total: count.total,
      totalCapped: count.capped,
      totalEstimated: count.estimated ?? false,
      page: q.page,
      size: q.size,
      rows,
    };
    await this.cache.setJson(respKey, result, 60);
    return result;
  }

  private async exportColumns(key: string) {
    const catalog = await this.catalogs.forDataset(key);
    return Object.values(catalog.recordFields).map((c) => ({ key: c.key, label: c.label }));
  }

  async exportCsv(key: string, res: Response, filters: FindingsFilter) {
    const [ctx, columns] = await Promise.all([this.contextFor(key), this.exportColumns(key)]);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=${key}_dataset.csv`);
    res.write(columns.map((c) => c.label).join(",") + "\r\n");
    const csvCell = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = Array.isArray(v) ? v.join("; ") : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for await (const batch of this.repo.streamFindings(ctx, filters)) {
      res.write(batch.map((r: any) => columns.map((c) => csvCell(r[c.key])).join(",")).join("\r\n") + "\r\n");
    }
    res.end();
  }

  async exportExcel(key: string, res: Response, filters: FindingsFilter) {
    const [ctx, columns] = await Promise.all([this.contextFor(key), this.exportColumns(key)]);
    await this.exportSvc.streamExcel(res, `${key}_dataset.xlsx`, columns, this.repo.streamFindings(ctx, filters));
  }

  async exportPdf(key: string, res: Response, filters: FindingsFilter) {
    const [ctx, columns, catalog] = await Promise.all([
      this.contextFor(key), this.exportColumns(key), this.catalogs.forDataset(key),
    ]);
    await this.exportSvc.streamPdf(res, `${key}_dataset.pdf`, catalog.name, columns, this.repo.streamFindings(ctx, filters));
  }
}
