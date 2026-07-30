import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { from as copyFrom } from "pg-copy-streams";
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

const ID_RE = /^[a-z][a-z0-9_]{0,58}$/;

/** One CSV field for COPY's default CSV format: quote+escape only when needed,
 *  and render null/undefined as a bare empty field (COPY CSV's NULL marker) —
 *  never `""`, which COPY reads as an actual empty string, not NULL. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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

  /** Which dataset keys are mid-sync right now, per this process's in-memory lock. */
  runningKeys(): string[] {
    return [...this.running];
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
      this.log.log(`sync ${key} starting (${full ? "full" : "incremental"}), key=${ds.key_column}, watermark=${ds.watermark_column ?? "none"}`);

      const since = full ? null : await this.watermark(key);
      const total = await this.copy(ds, mappings, since);

      const ms = Date.now() - t0;
      await this.setState(key, { last_status: "ok", rows_synced: total, duration_ms: ms, last_error: null });
      await this.history(key, full ? "full" : "incremental", "ok", total, null, startedAt, ms);

      // Fresh data -> chart matviews and cached pages must be rebuilt.
      if (total > 0) {
        this.log.log(`sync ${key}: refreshing chart matviews and caches…`);
        await this.refreshDerived(key, ds.target_table);
      }
      this.log.log(
        `sync ${key}: DONE — ok, ${total.toLocaleString()} rows in ${(ms / 1000).toFixed(1)}s (${full ? "full" : "incremental"})`,
      );
      return { rows: total };
    } catch (e: any) {
      const ms = Date.now() - t0;
      const msg = e?.message ?? String(e);
      const partial = typeof e?.partialRows === "number" ? e.partialRows : 0;
      await this.setState(key, { last_status: "error", last_error: msg, duration_ms: ms, rows_synced: partial });
      await this.history(key, full ? "full" : "incremental", "error", partial, msg, startedAt, ms);
      this.log.error(
        `sync ${key}: DONE — FAILED after ${partial.toLocaleString()} rows, ${(ms / 1000).toFixed(1)}s: ${msg}`,
      );
      throw e;
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * Pull the whole matching result set as ONE streamed MS SQL query, COPY it
   * straight into a per-run temp staging table (COPY is Postgres's fastest bulk-
   * load path — no per-row/per-batch SQL parsing or planning), then a single
   * set-based INSERT...ON CONFLICT moves it into the real table. This replaced an
   * earlier page-at-a-time approach (1000 rows per round trip) that was fine on a
   * fast local link but dominated wall-clock time on a slow/high-latency one —
   * 10M rows at 1000/page is 10,000 MS SQL round trips before counting the work.
   * Streaming pays that latency once.
   *
   * The real table is only ever touched by the final INSERT — everything before
   * that only writes to the temp table, so dashboards/reports stay fully readable
   * for the entire (possibly long) pull, not just briefly locked at the very end.
   * The whole thing runs in one transaction: any failure rolls back cleanly with
   * zero effect on the real table, and the temp table (ON COMMIT DROP) needs no
   * manual cleanup either way.
   */
  private async copy(ds: DatasetRow, mappings: MappingRow[], since: Date | null): Promise<number> {
    const cols = mappings.map((m) => m.target_column);
    for (const c of [...cols, ds.target_table]) {
      if (!ID_RE.test(c)) throw new BadRequestException(`Unsafe identifier '${c}'`);
    }
    const allCols = ["record_id", ...cols];
    const staging = `sync_stage_${ds.key.replace(/[^a-z0-9_]/gi, "_")}`;

    let total = 0;
    let maxWatermark: Date | null = since;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // This run's own commit durability only — a crash losing the last few ms of
      // WAL flush for THIS transaction just means re-syncing, not real data loss,
      // and it's a meaningful speedup for a transaction this size.
      await client.query("SET LOCAL synchronous_commit = OFF");
      // The streaming/staging phase never touches the real table, so it can't be
      // blocked by anything holding a lock on it — but the final merge below does,
      // and without a bound, a stray long-running query elsewhere (a report, a
      // manual admin query) holding a conflicting lock would hang this indefinitely
      // too. 60s is generous for a lock wait that should normally be instant; if
      // it's not free within that, something is genuinely wrong and the sync should
      // fail loudly rather than queue silently behind it.
      await client.query("SET LOCAL lock_timeout = '60s'");
      // Mirrors the real table's columns/types exactly (so COPY parses each field
      // with the correct type-specific parser, no manual casting needed) — but
      // fresh and unindexed, which is what makes COPY into it fast.
      await client.query(`CREATE TEMP TABLE ${staging} (LIKE ${ds.target_table} INCLUDING DEFAULTS) ON COMMIT DROP`);

      const { request, done } = await this.source.streamQuery({
        table: ds.source_table!, watermarkColumn: ds.watermark_column, since,
      });

      let lastLog = Date.now();
      await new Promise<void>((resolve, reject) => {
        const copyStream = client.query(copyFrom(`COPY ${staging} (${allCols.join(",")}) FROM STDIN WITH (FORMAT csv)`));
        let settled = false;
        const settle = (err?: any) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };
        copyStream.on("error", settle);
        copyStream.on("finish", () => settle());

        request.on("row", (row: any) => {
          const recordId = toNumber(row[ds.key_column]);
          if (recordId === null) return; // no Archer record id -> can't upsert it safely
          total++;
          if (ds.watermark_column) {
            const d = toDate(row[ds.watermark_column]);
            if (d && (!maxWatermark || d > maxWatermark)) maxWatermark = d;
          }
          const vals = [recordId, ...mappings.map((m) => this.convert(row[m.archer_field_name], m.transform))];
          const ok = copyStream.write(vals.map(csvField).join(",") + "\n");
          if (!ok) {
            request.pause();
            copyStream.once("drain", () => request.resume());
          }
          // Proof-of-life: with no other progress signal, a genuinely working sync
          // and a silently stuck one look identical from the outside. A line every
          // ~10s makes that observable instead of just waiting and hoping.
          if (Date.now() - lastLog > 10_000) {
            this.log.log(`sync ${ds.key}: ${total} rows so far (still running)…`);
            lastLog = Date.now();
          }
        });
        request.on("error", (err: any) => { copyStream.destroy(err); settle(err); });
        done.then(() => copyStream.end()).catch((err) => { copyStream.destroy(err); settle(err); });
      });

      // The MS SQL pull is done at this point — total won't climb any further —
      // but a 10M-row merge into the real table is itself not instant, and prints
      // nothing on its own. Without this line, "rows so far" stops climbing and it
      // looks stuck again for however long this next step takes.
      this.log.log(`sync ${ds.key}: ${total} rows staged, merging into ${ds.target_table}…`);
      if (total > 0) {
        const t1 = Date.now();
        const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
        await client.query(
          `INSERT INTO ${ds.target_table} (${allCols.join(", ")})
           SELECT ${allCols.join(", ")} FROM ${staging}
           ON CONFLICT (record_id) DO UPDATE SET ${updates}, synced_at = now()`,
        );
        this.log.log(`sync ${ds.key}: merge done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
      }
      await client.query("COMMIT");
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => undefined);
      // A failure partway through shouldn't hide the rows that were already staged
      // — the caller reports this as the row count on the failed run, instead of a
      // flat 0 that makes real progress look like none happened at all.
      e.partialRows = total;
      throw e;
    } finally {
      client.release();
    }

    if (maxWatermark) await this.setState(ds.key, { last_watermark: maxWatermark });
    return total;
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
  private async refreshDerived(key: string, targetTable: string) {
    this.catalogs.invalidate(key);
    // ON CONFLICT DO UPDATE rewrites a row rather than truly updating it in place
    // (Postgres MVCC) — after a sync that touched a large share of a 10M-row
    // table, both its size-on-disk and its planner statistics have shifted enough
    // to matter. ANALYZE is cheap and non-locking (safe to run inline here); the
    // dead-tuple side of that is autovacuum's job — see the sync architecture notes
    // for the per-table tuning this table's daily rewrite volume calls for.
    await this.db.query(`ANALYZE ${targetTable}`).catch((e) =>
      this.log.warn(`analyze ${targetTable} failed: ${e?.message ?? e}`),
    );
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
