import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { Request as MssqlRequest } from "mssql";
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
 * record_id is BIGINT (chosen because Archer's own ContentId is a plain integer,
 * the common case) — but not every real source key is numeric ("VSR-2024-00123"
 * style ids exist too). Rather than force every dataset's key column to be a
 * number, a non-numeric key gets mapped to a stable synthetic bigint instead of
 * being dropped: the same string always hashes to the same id, so re-syncing the
 * same source row still upserts correctly rather than duplicating or vanishing.
 * SHA-256 truncated to 63 bits has a negligible collision chance at any dataset
 * size this app deals with (10M rows is nowhere near enough to matter).
 * Numeric keys are untouched — this only ever changes behavior for the rows that
 * would otherwise have been silently skipped.
 */
function stableRecordId(raw: string): bigint {
  const hash = createHash("sha256").update(raw).digest();
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(hash[i]);
  return n & 0x7fffffffffffffffn; // clear the sign bit -> always fits a positive signed bigint
}

/** The value to key a row on: numeric keys pass through unchanged (existing
 *  behavior, unaffected); anything else gets a stable hash instead of being
 *  dropped; a genuinely empty/null key still can't be keyed on at all. */
function resolveRecordId(raw: unknown): number | bigint | null {
  const asNumber = toNumber(raw);
  if (asNumber !== null) return asNumber;
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  return s ? stableRecordId(s) : null;
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
  // The in-flight MS SQL request for each running dataset, so an admin can cancel
  // one specific stuck/unwanted sync instead of the only prior option — restarting
  // the whole backend, which kills every other in-progress sync too.
  private cancelable = new Map<string, MssqlRequest>();

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

  /**
   * Abort one dataset's in-progress sync without touching any other running sync
   * or the backend process itself. Cancels the underlying MS SQL request, which
   * makes the pull's promise reject — the existing error path then does its normal
   * job: ROLLBACK (nothing partial is left behind), state/history recorded as a
   * cancelled run, and the in-memory lock released so it can be started again.
   * Returns false if that dataset isn't actually running (nothing to cancel).
   */
  cancelSync(key: string): boolean {
    const req = this.cancelable.get(key);
    if (!req) return false;
    req.cancel();
    return true;
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
      // copy() commits in chunks now (not one all-or-nothing transaction), so
      // partialRows is the real, currently-in-the-table count on a failure partway
      // through — earlier chunks already committed and stay committed — not a
      // guess or an in-flight number that gets wiped by a rollback.
      const saved = typeof e?.partialRows === "number" ? e.partialRows : 0;
      const msg = e?.message ?? String(e);
      await this.setState(key, { last_status: "error", last_error: msg, duration_ms: ms, rows_synced: saved });
      await this.history(key, full ? "full" : "incremental", "error", saved, msg, startedAt, ms);
      this.log.error(`sync ${key}: DONE — FAILED, ${saved.toLocaleString()} rows saved before the error, ${(ms / 1000).toFixed(1)}s: ${msg}`);
      throw e;
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * Pull rows as ONE streamed MS SQL query (versus the earlier page-at-a-time
   * approach, which paid a full network round trip per 1000 rows — 10,000 round
   * trips for a 10M-row table before counting any actual work), and commit them
   * into the real table in CHUNKS (via COPY into a temp staging table, then one
   * set-based INSERT...ON CONFLICT) rather than one giant transaction for the
   * whole pull. Chunked commits matter for two real reasons: rows actually show
   * up in the real table as the sync progresses, not only if/when the entire
   * multi-hour pull finishes — and a failure partway through only loses the
   * current chunk, not every row pulled so far.
   */
  private async copy(ds: DatasetRow, mappings: MappingRow[], since: Date | null): Promise<number> {
    const cols = mappings.map((m) => m.target_column);
    for (const c of [...cols, ds.target_table]) {
      if (!ID_RE.test(c)) throw new BadRequestException(`Unsafe identifier '${c}'`);
    }
    const allCols = ["record_id", ...cols];
    const staging = `sync_stage_${ds.key.replace(/[^a-z0-9_]/gi, "_")}`;
    const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    const CHUNK_ROWS = 50_000;

    let total = 0; // rows read from the source so far (progress display + return value)
    let committed = 0; // rows actually committed into the real table so far
    let maxWatermark: Date | null = since;
    let buffer: string[] = [];
    let lastLog = Date.now();

    /** COPY one chunk's CSV lines into a fresh staging table, merge into the real
     *  table, commit — small self-contained transaction, not the whole pull. */
    const flushChunk = async (lines: string[]): Promise<void> => {
      if (!lines.length) return;
      const client = await this.db.connect();
      try {
        await client.query("BEGIN");
        // This chunk's own commit durability only — losing the last few ms of WAL
        // flush on a crash just means re-syncing this chunk, not real data loss.
        await client.query("SET LOCAL synchronous_commit = OFF");
        // The merge below is the only step that touches the real table (and so is
        // the only step a conflicting lock elsewhere could block) — bounded so a
        // stray long-running query fails this loudly instead of hanging it.
        await client.query("SET LOCAL lock_timeout = '60s'");
        await client.query(`CREATE TEMP TABLE ${staging} (LIKE ${ds.target_table} INCLUDING DEFAULTS) ON COMMIT DROP`);
        await new Promise<void>((resolve, reject) => {
          const copyStream = client.query(copyFrom(`COPY ${staging} (${allCols.join(",")}) FROM STDIN WITH (FORMAT csv)`));
          copyStream.on("error", reject);
          copyStream.on("finish", () => resolve());
          copyStream.end(lines.join(""));
        });
        await client.query(
          `INSERT INTO ${ds.target_table} (${allCols.join(", ")})
           SELECT ${allCols.join(", ")} FROM ${staging}
           ON CONFLICT (record_id) DO UPDATE SET ${updates}, synced_at = now()`,
        );
        await client.query("COMMIT");
        committed += lines.length;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    };

    const { request, done } = await this.source.streamQuery({
      table: ds.source_table!, watermarkColumn: ds.watermark_column, since,
    });
    this.cancelable.set(ds.key, request);

    try {
      let pendingFlush: Promise<void> = Promise.resolve();
      let failed = false;
      await new Promise<void>((resolve, reject) => {
        const fail = (err: any) => {
          if (failed) return;
          failed = true;
          reject(err);
        };

        request.on("row", (row: any) => {
          const recordId = resolveRecordId(row[ds.key_column]);
          if (recordId === null) return; // genuinely empty key -> nothing to safely upsert on
          total++;
          if (ds.watermark_column) {
            const d = toDate(row[ds.watermark_column]);
            if (d && (!maxWatermark || d > maxWatermark)) maxWatermark = d;
          }
          const vals = [recordId, ...mappings.map((m) => this.convert(row[m.archer_field_name], m.transform))];
          buffer.push(vals.map(csvField).join(",") + "\n");

          // Proof-of-life: with no other progress signal, a genuinely working sync
          // and a silently stuck one look identical from the outside. A line every
          // ~10s makes that observable instead of just waiting and hoping.
          if (Date.now() - lastLog > 10_000) {
            this.log.log(`sync ${ds.key}: ${total} rows read, ${committed} committed so far (still running)…`);
            lastLog = Date.now();
          }

          if (buffer.length >= CHUNK_ROWS) {
            request.pause(); // no more rows arrive until this chunk finishes committing
            const chunk = buffer;
            buffer = [];
            pendingFlush = flushChunk(chunk)
              .then(() => { request.resume(); })
              .catch(fail);
          }
        });
        request.on("error", fail);
        done
          .then(async () => {
            await pendingFlush; // let any in-flight chunk finish first
            await flushChunk(buffer); // the final, partial chunk
            buffer = [];
            resolve();
          })
          .catch(fail);
      });
    } catch (e: any) {
      // Unlike total (rows merely read off the wire), committed is only ever
      // incremented after a chunk's own COMMIT succeeds — so on failure it's the
      // real, currently-in-the-table count, not a guess. The caller reports this
      // as rows_synced, since with chunked commits it's now actually accurate.
      e.partialRows = committed;
      throw e;
    } finally {
      this.cancelable.delete(ds.key);
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
