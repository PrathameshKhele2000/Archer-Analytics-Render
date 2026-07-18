import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { DbService } from "../database/db.service";
import { CatalogService } from "../datasets/catalog.service";
import { DatasetRow } from "../datasets/dataset.entity";
import { MssqlSource } from "./mssql.source";

interface MappingRow {
  archer_field_name: string; // the SOURCE column name in the flat feed
  target_column: string;
  transform: string;
  is_enabled: boolean;
}

const BATCH = 1000;
const ID_RE = /^[a-z][a-z0-9_]{0,58}$/;

/** Split a delimited multi-value cell ("a@x.com; b@x.com") into a JSON list. */
function toList(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  // Split multi-value cells on comma, semicolon or pipe — whichever the flat feed uses.
  return String(v)
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Copies one dataset's rows from the flat Archer reporting feed (MS SQL) into its
 * table here. One pipe at a time, read-only at the source, and idempotent: rows are
 * upserted on the Archer record id, so re-running never duplicates.
 */
@Injectable()
export class DatasetSyncService {
  private readonly log = new Logger(DatasetSyncService.name);
  private running = new Set<string>();

  constructor(
    private readonly db: DbService,
    private readonly source: MssqlSource,
    private readonly catalogs: CatalogService,
    private readonly cache: CacheService,
  ) {}

  /** Apply a field's transform, turning a source cell into what the column expects. */
  private convert(value: unknown, transform: string): unknown {
    switch (transform) {
      case "users_list":
      case "xref_display":
      case "xref_ids":
        return JSON.stringify(toList(value));
      case "json":
        return value === null || value === undefined ? "[]" : JSON.stringify(value);
      case "number":
        return toNumber(value);
      case "date":
        return toDate(value);
      default:
        return value === undefined ? null : value;
    }
  }

  private async datasetByKey(key: string): Promise<DatasetRow> {
    const { rows } = await this.db.query<DatasetRow>(`SELECT * FROM dataset WHERE key = $1`, [key]);
    if (!rows[0]) throw new BadRequestException(`Unknown dataset '${key}'`);
    return rows[0];
  }

  /** Every dataset the scheduler should pull: active, with a source table configured. */
  async syncableDatasets(): Promise<DatasetRow[]> {
    const { rows } = await this.db.query<DatasetRow>(
      `SELECT * FROM dataset WHERE is_active AND source_table IS NOT NULL AND source_table <> '' ORDER BY id`,
    );
    return rows;
  }

  /** Sync every configured pipe. Datasets are independent: one failing can't stop the others. */
  async syncAll(full = false): Promise<{ dataset: string; status: string; rows: number; error?: string }[]> {
    if (!this.source.isConfigured()) {
      this.log.warn("MS SQL source not configured — skipping sync");
      return [];
    }
    const out = [];
    for (const ds of await this.syncableDatasets()) {
      try {
        const r = await this.syncDataset(ds.key, full);
        out.push({ dataset: ds.key, status: "ok", rows: r.rows });
      } catch (e: any) {
        out.push({ dataset: ds.key, status: "error", rows: 0, error: e?.message ?? String(e) });
      }
    }
    return out;
  }

  async syncDataset(key: string, full = false): Promise<{ rows: number }> {
    if (this.running.has(key)) throw new BadRequestException(`Sync for '${key}' is already running`);
    this.running.add(key);
    const startedAt = new Date();
    const t0 = Date.now();

    try {
      const ds = await this.datasetByKey(key);
      if (!ds.source_table) throw new BadRequestException(`Dataset '${key}' has no source table configured`);

      const mappings = await this.enabledMappings(key);
      if (!mappings.length) {
        throw new BadRequestException(`Dataset '${key}' has no field mapping yet — run Auto-map in Field Mapping`);
      }

      await this.setState(key, { last_status: "running", last_run_at: startedAt });

      const since = full ? null : await this.watermark(key);
      const total = await this.copy(ds, mappings, since);

      const ms = Date.now() - t0;
      await this.setState(key, { last_status: "ok", rows_synced: total, duration_ms: ms, last_error: null });
      await this.history(key, full ? "full" : "incremental", "ok", total, null, startedAt, ms);

      // Fresh data -> chart matviews and cached pages must be rebuilt.
      if (total > 0) await this.refreshDerived(key);
      this.log.log(`sync ${key}: ${total} rows in ${ms}ms (${full ? "full" : "incremental"})`);
      return { rows: total };
    } catch (e: any) {
      const ms = Date.now() - t0;
      const msg = e?.message ?? String(e);
      await this.setState(key, { last_status: "error", last_error: msg, duration_ms: ms });
      await this.history(key, full ? "full" : "incremental", "error", 0, msg, startedAt, ms);
      this.log.error(`sync ${key} failed: ${msg}`);
      throw e;
    } finally {
      this.running.delete(key);
    }
  }

  /** Read the source in batches and upsert each one. */
  private async copy(ds: DatasetRow, mappings: MappingRow[], since: Date | null): Promise<number> {
    const cols = mappings.map((m) => m.target_column);
    for (const c of [...cols, ds.target_table]) {
      if (!ID_RE.test(c)) throw new BadRequestException(`Unsafe identifier '${c}'`);
    }

    let offset = 0;
    let total = 0;
    let maxWatermark: Date | null = since;

    for (;;) {
      const batch = await this.source.readBatch({
        table: ds.source_table!,
        keyColumn: ds.key_column,
        watermarkColumn: ds.watermark_column,
        since,
        offset,
        limit: BATCH,
      });
      if (!batch.length) break;

      await this.upsert(ds, mappings, batch);
      total += batch.length;

      if (ds.watermark_column) {
        for (const row of batch) {
          const d = toDate(row[ds.watermark_column]);
          if (d && (!maxWatermark || d > maxWatermark)) maxWatermark = d;
        }
      }
      offset += batch.length;
      if (batch.length < BATCH) break;
    }

    if (maxWatermark) await this.setState(ds.key, { last_watermark: maxWatermark });
    return total;
  }

  /** One multi-row INSERT ... ON CONFLICT per batch — idempotent on the Archer record id. */
  private async upsert(ds: DatasetRow, mappings: MappingRow[], batch: any[]) {
    const cols = mappings.map((m) => m.target_column);
    const allCols = ["record_id", ...cols];
    const params: any[] = [];
    const tuples: string[] = [];

    for (const row of batch) {
      const recordId = toNumber(row[ds.key_column]);
      if (recordId === null) continue; // no Archer record id -> can't upsert it safely
      const vals: any[] = [recordId, ...mappings.map((m) => this.convert(row[m.archer_field_name], m.transform))];
      const start = params.length;
      params.push(...vals);
      tuples.push(`(${vals.map((_, i) => `$${start + i + 1}`).join(", ")})`);
    }
    if (!tuples.length) return;

    const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    await this.db.query(
      `INSERT INTO ${ds.target_table} (${allCols.join(", ")})
       VALUES ${tuples.join(", ")}
       ON CONFLICT (record_id) DO UPDATE SET ${updates}, synced_at = now()`,
      params,
    );
  }

  private async enabledMappings(key: string): Promise<MappingRow[]> {
    const { rows } = await this.db.query<MappingRow>(
      `SELECT archer_field_name, target_column, transform, is_enabled
       FROM field_mapping
       WHERE source = $1 AND is_enabled AND target_column IS NOT NULL
       ORDER BY archer_field_name`,
      [key],
    );
    return rows;
  }

  private async watermark(key: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ last_watermark: Date | null }>(
      `SELECT last_watermark FROM dataset_sync_state WHERE dataset_key = $1`, [key],
    );
    return rows[0]?.last_watermark ?? null;
  }

  private async setState(key: string, patch: Record<string, any>) {
    const entries = Object.entries(patch);
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(
      `INSERT INTO dataset_sync_state (dataset_key) VALUES ($1) ON CONFLICT (dataset_key) DO NOTHING`, [key],
    );
    if (entries.length) {
      await this.db.query(`UPDATE dataset_sync_state SET ${sets} WHERE dataset_key = $1`,
        [key, ...entries.map(([, v]) => v)]);
    }
  }

  private async history(
    key: string, runType: string, status: string, rows: number,
    error: string | null, startedAt: Date, ms: number,
  ) {
    await this.db.query(
      `INSERT INTO dataset_sync_history (dataset_key, run_type, status, rows_synced, error_detail, started_at, finished_at, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7)`,
      [key, runType, status, rows, error, startedAt, ms],
    );
  }

  /** After new data lands: rebuild that dataset's chart matviews and drop stale caches. */
  private async refreshDerived(key: string) {
    this.catalogs.invalidate(key);
    const { rows } = await this.db.query<{ matviewname: string }>(
      `SELECT matviewname FROM pg_matviews WHERE matviewname LIKE 'mv_chart_%'`,
    );
    for (const r of rows) {
      await this.db.query(`REFRESH MATERIALIZED VIEW ${r.matviewname}`).catch((e) =>
        this.log.warn(`refresh ${r.matviewname} failed: ${e?.message ?? e}`),
      );
    }
    await this.cache.invalidatePrefix("dash:").catch(() => undefined);
    await this.cache.invalidatePrefix("report:").catch(() => undefined);
  }

  async status() {
    const { rows } = await this.db.query(
      `SELECT s.dataset_key AS module_alias, s.last_status, s.last_run_at, s.rows_synced,
              s.last_error AS error_detail, s.last_watermark, d.source_table, d.target_table
       FROM dataset_sync_state s
       LEFT JOIN dataset d ON d.key = s.dataset_key
       ORDER BY s.dataset_key`,
    );
    return rows;
  }

  async history_(limit = 50) {
    const { rows } = await this.db.query(
      `SELECT id, dataset_key AS module_alias, run_type, status, rows_synced,
              error_detail, started_at, finished_at, duration_ms
       FROM dataset_sync_history ORDER BY started_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`,
    );
    return rows;
  }
}
