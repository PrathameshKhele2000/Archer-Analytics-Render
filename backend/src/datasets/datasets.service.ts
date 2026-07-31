import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { MssqlSource } from "../sync-source/mssql.source";
import {
  alterUsingFor,
  assertColumn,
  assertDatasetKey,
  assertDataType,
  buildCreateTableSql,
  DatasetFieldRow,
  DatasetRow,
  FieldSpec,
  normalizeKey,
  resolveColumnKey,
  sqlTypeFor,
  targetTableFor,
} from "./dataset.entity";
import { CatalogService } from "./catalog.service";
import { CreateDatasetDto, UpdateDatasetDto } from "./dto/dataset.dto";

@Injectable()
export class DatasetsService {
  private readonly log = new Logger(DatasetsService.name);

  constructor(
    private readonly db: DbService,
    private readonly catalogs: CatalogService,
    private readonly source: MssqlSource,
  ) {}

  /**
   * A live (MS SQL-backed) dataset's key/watermark columns must be real columns on
   * the real source table — otherwise every sync silently saves a name SQL Server
   * later rejects with "Invalid column name", a failure an admin only discovers
   * after clicking Run full sync and finding zero rows with no clear reason why.
   * Checked here, at save time, so a bad value can never be stored at all.
   */
  private async validateLiveColumns(sourceTable: string, keyColumn: string | undefined, watermarkColumn?: string | null) {
    if (!keyColumn?.trim()) {
      throw new BadRequestException(
        "Key column is required for a live source — set it to the real unique-id column from the source table (use Discover columns).",
      );
    }
    const columns = await this.source.describeTable(sourceTable);
    const real = new Set(columns.map((c) => c.name.toLowerCase()));
    const names = columns.map((c) => c.name).join(", ");
    if (!real.has(keyColumn.trim().toLowerCase())) {
      throw new BadRequestException(`Key column '${keyColumn}' does not exist on '${sourceTable}'. Real columns: ${names}`);
    }
    if (watermarkColumn?.trim() && !real.has(watermarkColumn.trim().toLowerCase())) {
      throw new BadRequestException(`Watermark column '${watermarkColumn}' does not exist on '${sourceTable}'. Real columns: ${names}`);
    }
  }

  async list() {
    const { rows } = await this.db.query(
      `SELECT d.*,
              (SELECT count(*) FROM dataset_field f WHERE f.dataset_id = d.id)::int AS field_count,
              to_regclass(d.target_table) IS NOT NULL AS table_exists
       FROM dataset d ORDER BY d.is_protected DESC, d.name`,
    );
    return rows;
  }

  async fields(id: number): Promise<DatasetFieldRow[]> {
    const { rows } = await this.db.query<DatasetFieldRow>(
      `SELECT * FROM dataset_field WHERE dataset_id = $1 ORDER BY sort_order, key`,
      [id],
    );
    return rows;
  }

  /**
   * Normalize a submitted field list into safe, unique column names. Column-name
   * collisions (a CSV header like "Record Id" normalizing to our reserved `record_id`,
   * two columns both called "Status", a header of pure symbols) are resolved by
   * renaming rather than rejected — a client's raw CSV headers should never be able to
   * abort dataset creation. Only a genuinely empty field list, or an unrecognised data
   * type, is still a hard error.
   */
  private resolveFields(dto: CreateDatasetDto): FieldSpec[] {
    if (!dto.fields?.length) throw new BadRequestException("Add at least one field");
    const taken = new Set<string>();
    return dto.fields.map((f, i) => {
      const key = resolveColumnKey(f.key || f.label, i, taken);
      return {
        key,
        label: (f.label || f.key || key).trim(),
        data_type: assertDataType(f.data_type),
        is_dimension: !!f.is_dimension,
        is_measurable: !!f.is_measurable,
        is_searchable: !!f.is_searchable,
      };
    });
  }

  /** The exact DDL that Create would run — shown to the admin before anything happens. */
  previewSql(dto: CreateDatasetDto): { targetTable: string; sql: string } {
    const key = assertDatasetKey(normalizeKey(dto.key || dto.name));
    const targetTable = targetTableFor(key);
    return { targetTable, sql: buildCreateTableSql(targetTable, this.resolveFields(dto)) };
  }

  /**
   * Register a dataset and build its table. Only ever CREATEs a new ds_* table —
   * it never alters an existing one, so adding a dataset cannot affect the others.
   */
  async create(dto: CreateDatasetDto) {
    const key = assertDatasetKey(normalizeKey(dto.key || dto.name));
    const targetTable = targetTableFor(key);
    const fields = this.resolveFields(dto);

    const existing = await this.db.query(`SELECT 1 FROM dataset WHERE key = $1`, [key]);
    if (existing.rows.length) throw new BadRequestException(`A dataset with key '${key}' already exists`);
    const clash = await this.db.query(`SELECT to_regclass($1) AS t`, [targetTable]);
    if (clash.rows[0]?.t) throw new BadRequestException(`Table '${targetTable}' already exists`);

    if (dto.sourceTable?.trim()) {
      await this.validateLiveColumns(dto.sourceTable.trim(), dto.keyColumn, dto.watermarkColumn);
    }

    await this.db.query(buildCreateTableSql(targetTable, fields));
    // A synced dataset gets rewritten (via ON CONFLICT DO UPDATE) a substantial
    // fraction of its rows on every sync — the default autovacuum thresholds (20%
    // dead rows / 10% stale stats) are tuned for ordinary OLTP tables, not one that
    // can rewrite itself daily, so it'd bloat and its query-planner stats would
    // lag without tighter ones. Set once here, automatically, at creation — no
    // admin ever needs to run this by hand on a server they can't easily touch.
    await this.db.query(
      `ALTER TABLE ${targetTable} SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)`,
    );
    this.log.log(`created dataset table ${targetTable} (${fields.length} fields)`);

    const { rows } = await this.db.query<DatasetRow>(
      `INSERT INTO dataset (key, name, description, source_table, target_table, key_column, watermark_column)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        key, dto.name.trim(), dto.description ?? null,
        dto.sourceTable ?? null, targetTable,
        dto.keyColumn?.trim() || null, dto.watermarkColumn?.trim() || null,
      ],
    );
    const dataset = rows[0];

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await this.db.query(
        `INSERT INTO dataset_field (dataset_id, key, label, data_type, is_dimension, is_measurable, is_searchable, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [dataset.id, f.key, f.label, f.data_type, !!f.is_dimension, !!f.is_measurable, !!f.is_searchable, i],
      );
    }

    // Seed the mapping rows so Field Mapping -> Auto-map works for this source too.
    for (const f of fields) {
      await this.db.query(
        `INSERT INTO field_mapping (source, archer_field_name, archer_field_type, target_column, transform)
         VALUES ($1,$2,$3,$4,'direct') ON CONFLICT (source, archer_field_name) DO NOTHING`,
        [key, f.label, f.data_type, f.key],
      );
    }

    // Give the dataset a default "register" report so it shows up in the Records tab
    // straight away (a dataset with no report has nothing to view there).
    await this.createRegisterReport(dataset.id, key, dto.name.trim(), targetTable, fields);
    this.catalogs.invalidate(key);
    return dataset;
  }

  /** A full register report for a dataset: all its fields as columns, visible to every role. */
  private async createRegisterReport(datasetId: number, key: string, name: string, table: string, fields: FieldSpec[]) {
    const regKey = `${key}-register`;
    const existing = await this.db.query(`SELECT 1 FROM reports WHERE key = $1`, [regKey]);
    if (existing.rows.length) return; // already has one
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reports (key, name, description, data_source, dataset_key, base_conditions, sort_order)
       VALUES ($1,$2,$3,$4,$5,'[]'::jsonb, 5) RETURNING id`,
      [regKey, name, `All ${name} records`, table, key],
    );
    const reportId = rows[0].id;
    for (let i = 0; i < fields.length; i++) {
      await this.db.query(
        `INSERT INTO report_columns (report_id, key, label, sortable, is_default_visible, sort_order)
         VALUES ($1,$2,$3,TRUE,$4,$5)`,
        [reportId, fields[i].key, fields[i].label, i < 12, i], // first 12 columns visible by default
      );
    }
    await this.db.query(`INSERT INTO report_access (report_id, role_id, user_id) SELECT $1, id, NULL FROM roles`, [reportId]);
  }

  /**
   * Edit a dataset: settings (name/source/keys) and its fields. Field flags and labels
   * change freely; adding/removing/retyping a field alters the ds_* table (never the
   * built-in findings table). The dataset's data is a re-syncable copy, so structural
   * changes are safe. Everything goes through validated identifiers (injection-safe).
   */
  async update(id: number, dto: UpdateDatasetDto) {
    const { rows } = await this.db.query<DatasetRow>(`SELECT * FROM dataset WHERE id = $1`, [id]);
    const ds = rows[0];
    if (!ds) throw new NotFoundException("Dataset not found");
    const structural = !ds.is_protected && /^ds_[a-z0-9_]+$/.test(ds.target_table); // add/drop/retype allowed?
    const table = ds.target_table;

    // Validate against the real source table whenever this request touches the
    // source table or either column and the dataset ends up with a source table set
    // — catches a bad "Record id column"/"Last-updated column" edit at Save time
    // instead of letting it through to fail later, silently, during sync.
    const effectiveSourceTable = (dto.sourceTable ?? ds.source_table)?.trim();
    const touchesLiveColumns = dto.sourceTable !== undefined || dto.keyColumn !== undefined || dto.watermarkColumn !== undefined;
    if (effectiveSourceTable && touchesLiveColumns) {
      const effectiveKeyColumn = dto.keyColumn?.trim() || ds.key_column;
      const effectiveWatermarkColumn = dto.watermarkColumn !== undefined ? dto.watermarkColumn : ds.watermark_column;
      await this.validateLiveColumns(effectiveSourceTable, effectiveKeyColumn, effectiveWatermarkColumn);
    }

    // 1. Settings (name / description / source table / id + watermark columns).
    await this.db.query(
      `UPDATE dataset SET name=COALESCE($2,name), description=COALESCE($3,description),
         source_table=COALESCE($4,source_table), key_column=COALESCE($5,key_column),
         watermark_column=COALESCE($6,watermark_column), updated_at=now() WHERE id=$1`,
      [id, dto.name?.trim() || null, dto.description ?? null,
       dto.sourceTable ?? null, dto.keyColumn?.trim() || null, dto.watermarkColumn ?? null],
    );

    // 2. Fields (only if provided).
    if (dto.fields) {
      // record_id is the primary key, never an editable field — keep it out of reconciliation.
      const { rows: existingAll } = await this.db.query<DatasetFieldRow>(
        `SELECT * FROM dataset_field WHERE dataset_id = $1`, [id],
      );
      const existing = existingAll.filter((f) => f.key !== "record_id");
      const byKey = new Map(existing.map((f) => [f.key, f]));
      // Keys already spoken for: every existing field's key (never renamed here — a
      // rename would need an ALTER TABLE RENAME COLUMN this path doesn't do, and would
      // break the byKey lookup below) plus our own reserved names.
      const taken = new Set(existing.map((f) => f.key));
      let idx = 0;
      const desired = dto.fields
        .filter((f) => (f.label ?? "").trim() && (f.key ?? "") !== "record_id")
        .map((f) => {
          const explicitKey = f.key?.trim();
          // An EXISTING field keeps its exact key — it identifies the column to alter,
          // not just a name to validate — so it is never subject to collision renaming.
          // Only a genuinely NEW field (no key yet, e.g. added by typing a label into
          // the edit form) needs a fresh, collision-safe key resolved for it.
          const key = explicitKey && byKey.has(explicitKey)
            ? assertColumn(explicitKey)
            : resolveColumnKey(explicitKey || f.label, idx, taken);
          idx++;
          return {
            key,
            label: f.label.trim(),
            data_type: assertDataType(f.data_type),
            is_dimension: !!f.is_dimension, is_measurable: !!f.is_measurable, is_searchable: !!f.is_searchable,
          };
        });

      for (let i = 0; i < desired.length; i++) {
        const f = desired[i];
        const cur = byKey.get(f.key);
        if (!cur) {
          if (!structural) throw new BadRequestException(`Can't add columns to the built-in '${ds.name}' dataset`);
          await this.db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${f.key} ${sqlTypeFor(f.data_type)}`);
          await this.db.query(
            `INSERT INTO dataset_field (dataset_id,key,label,data_type,is_dimension,is_measurable,is_searchable,sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, f.key, f.label, f.data_type, f.is_dimension, f.is_measurable, f.is_searchable, i]);
          await this.db.query(
            `INSERT INTO field_mapping (source,archer_field_name,archer_field_type,target_column,transform)
             VALUES ($1,$2,$3,$4,'direct') ON CONFLICT (source,archer_field_name) DO NOTHING`,
            [ds.key, f.label, f.data_type, f.key]);
        } else {
          if (cur.data_type !== f.data_type) {
            if (!structural) throw new BadRequestException(`Can't change column types on the built-in '${ds.name}' dataset`);
            try {
              await this.db.query(`ALTER TABLE ${table} ALTER COLUMN ${f.key} TYPE ${sqlTypeFor(f.data_type)} USING ${alterUsingFor(f.key, f.data_type)}`);
            } catch (e: any) {
              throw new BadRequestException(`Couldn't change '${f.label}' to ${f.data_type}: existing values aren't all compatible.`);
            }
          }
          await this.db.query(
            `UPDATE dataset_field SET label=$2,data_type=$3,is_dimension=$4,is_measurable=$5,is_searchable=$6,sort_order=$7 WHERE id=$1`,
            [cur.id, f.label, f.data_type, f.is_dimension, f.is_measurable, f.is_searchable, i]);
        }
      }
      // Remove fields the edit dropped.
      for (const cur of existing) {
        if (desired.some((f) => f.key === cur.key)) continue;
        if (!structural) throw new BadRequestException(`Can't remove columns from the built-in '${ds.name}' dataset`);
        await this.db.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${cur.key}`);
        await this.db.query(`DELETE FROM dataset_field WHERE id = $1`, [cur.id]);
        await this.db.query(`DELETE FROM field_mapping WHERE source = $1 AND target_column = $2`, [ds.key, cur.key]);
      }
    }

    this.catalogs.invalidate(ds.key); // rebuild this dataset's chart/report catalog
    const { rows: after } = await this.db.query<DatasetRow>(`SELECT * FROM dataset WHERE id = $1`, [id]);
    this.log.log(`updated dataset ${ds.key}`);
    return after[0];
  }

  /**
   * Load rows into a dataset's table from parsed CSV objects (header -> value).
   * Each row is matched to the dataset's fields by the field's label (= the CSV
   * header it was created from), converted to the column's type, and upserted on
   * record_id. Column names come from the registry (validated), so it's injection-safe.
   */
  async importRows(
    id: number, rows: Record<string, any>[], keyColumn?: string,
  ): Promise<{ loaded: number; duplicates: number; skipped: number }> {
    const { rows: dsRows } = await this.db.query<DatasetRow>(`SELECT * FROM dataset WHERE id = $1`, [id]);
    const dataset = dsRows[0];
    if (!dataset) throw new NotFoundException("Dataset not found");
    if (!/^ds_[a-z0-9_]+$|^fact_findings$/.test(dataset.target_table)) {
      throw new BadRequestException(`Cannot import into '${dataset.target_table}'`);
    }
    if (!Array.isArray(rows) || !rows.length) throw new BadRequestException("No rows to import");
    if (rows.length > 100_000) throw new BadRequestException("CSV too large (max 100,000 rows per import)");

    const { rows: fields } = await this.db.query<DatasetFieldRow>(
      `SELECT * FROM dataset_field WHERE dataset_id = $1 ORDER BY sort_order`, [id],
    );
    if (!fields.length) throw new BadRequestException("Dataset has no fields");
    for (const f of fields) assertColumn(f.key);

    const cols = ["record_id", ...fields.map((f) => f.key)];
    const convert = (v: any, type: string): any => {
      if (v === undefined || v === null || v === "") return null;
      if (type === "integer") { const n = parseInt(String(v), 10); return Number.isNaN(n) ? null : n; }
      if (type === "number") { const n = Number(v); return Number.isNaN(n) ? null : n; }
      if (type === "boolean") return /^(true|1|yes|y)$/i.test(String(v).trim());
      if (type === "json") {
        const str = String(v).trim();
        if (str.startsWith("[")) { try { return JSON.stringify(JSON.parse(str)); } catch { /* fall through to split */ } }
        // Multi-value cell -> array. Split on comma, semicolon or pipe (a comma-separated
        // cell must be quoted in the CSV so it isn't read as separate columns).
        return JSON.stringify(str.split(/[,;|]/).map((x) => x.trim()).filter(Boolean));
      }
      return String(v); // text / date / timestamp — Postgres parses date/timestamp strings
    };

    // Resolve every row's id FIRST, across the WHOLE file, before any batching. A
    // single INSERT ... ON CONFLICT DO UPDATE statement cannot touch the same key
    // twice — Postgres rejects the entire statement with "ON CONFLICT DO UPDATE
    // command cannot affect row a second time" — so two source rows that happen to
    // share an id (a real-world CSV export artifact: a re-exported date range, a
    // history/versioning row, or just a duplicate) used to take out the WHOLE 500-row
    // batch containing them, silently dropping hundreds of otherwise-good rows and
    // surfacing only as an opaque 500 to the admin.
    //
    // A Map keyed by id naturally resolves this exactly the way a second CSV import
    // of the same key already behaves (upsert = last write wins): iterating the file
    // in order and re-setting the same key just replaces the stored row, so by
    // construction no key can ever appear twice in what gets batched below.
    let skipped = 0; // rows with no usable id (only possible via a bad keyColumn value)
    const byId = new Map<number, Record<string, any>>();
    rows.forEach((row, i) => {
      const rid = keyColumn && row[keyColumn] != null && String(row[keyColumn]).trim() !== ""
        ? parseInt(String(row[keyColumn]).replace(/[^\d-]/g, ""), 10)
        : i + 1; // no id column -> sequential row number (already unique per file)
      if (Number.isNaN(rid)) { skipped++; return; }
      byId.set(rid, row);
    });
    const duplicates = rows.length - skipped - byId.size;
    const deduped = [...byId.entries()];

    let loaded = 0;
    // Upsert in batches to keep statements a sensible size.
    for (let start = 0; start < deduped.length; start += 500) {
      const batch = deduped.slice(start, start + 500);
      const params: any[] = [];
      const tuples: string[] = [];
      for (const [rid, row] of batch) {
        const vals = [rid, ...fields.map((f) => convert(row[f.label], f.data_type))];
        const base = params.length;
        params.push(...vals);
        tuples.push(`(${vals.map((_, j) => `$${base + j + 1}`).join(",")})`);
      }
      if (!tuples.length) continue;
      const updates = fields.map((f) => `${f.key} = EXCLUDED.${f.key}`).join(", ");
      await this.db.query(
        `INSERT INTO ${dataset.target_table} (${cols.join(",")}) VALUES ${tuples.join(",")}
         ON CONFLICT (record_id) DO UPDATE SET ${updates}, synced_at = now()`,
        params,
      );
      loaded += tuples.length;
    }
    this.log.log(
      `imported ${loaded} rows into ${dataset.target_table} from CSV` +
      (duplicates ? ` (${duplicates} duplicate id(s) collapsed, last occurrence kept)` : "") +
      (skipped ? ` (${skipped} row(s) skipped: no usable id)` : ""),
    );
    return { loaded, duplicates, skipped };
  }

  /**
   * Unregister a dataset and drop its table. Safe because the data is only ever a
   * copy of Archer's (re-syncable), and the guards below make it impossible to drop
   * anything that isn't a dataset table we generated.
   */
  async remove(id: number) {
    const { rows } = await this.db.query<DatasetRow>(`SELECT * FROM dataset WHERE id = $1`, [id]);
    const dataset = rows[0];
    if (!dataset) throw new NotFoundException("Dataset not found");
    // No dataset is undeletable, including the built-in "Vulnerability Findings" one
    // (target_table 'fact_findings') — is_protected no longer blocks removal, only
    // still guards against ALTERing its columns in update() (a different, more
    // invasive operation this doesn't touch). The name check stays as a safety net
    // against a dataset row somehow pointing at an unrelated, unmanaged table.
    if (!/^(ds_[a-z0-9_]+|fact_findings)$/.test(dataset.target_table)) {
      throw new BadRequestException(`Refusing to drop '${dataset.target_table}': not a generated dataset table`);
    }
    // Charts built against this dataset (directly or through a view) each get their own
    // mv_chart_<widgetId> matview (see DashboardRepository.createChartMatview). Postgres
    // refuses to drop a table while any matview still depends on it — that used to
    // surface as an opaque 500 on this endpoint. Find those matviews via pg_depend
    // (works regardless of whether the chart references the dataset directly or via a
    // view built on it) and drop them first, exactly as chart/dashboard deletion already
    // does per-widget; the chart itself is left in place but falls back to its "no
    // matview yet" behavior, matching what already happens for a brand-new chart.
    const { rows: dependentMatviews } = await this.db.query<{ relname: string }>(
      `SELECT DISTINCT dependent_view.relname
         FROM pg_depend
         JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid
         JOIN pg_class dependent_view ON pg_rewrite.ev_class = dependent_view.oid
         JOIN pg_class source_table ON pg_depend.refobjid = source_table.oid
        WHERE source_table.relname = $1 AND dependent_view.relkind = 'm'`,
      [dataset.target_table],
    );
    for (const { relname } of dependentMatviews) {
      await this.db.query(`DROP MATERIALIZED VIEW IF EXISTS ${relname}`);
      const widgetId = /^mv_chart_(\d+)(?:_build)?$/.exec(relname)?.[1];
      if (widgetId) await this.db.query(`DELETE FROM chart_matview_state WHERE widget_id = $1`, [Number(widgetId)]);
    }
    // Charts reference a dataset/view by KEY inside opaque config JSON, not a real
    // foreign key (see db/init.sql — dashboard_widgets.config has no FK), so nothing
    // about dropping the table above stops those charts from still existing —
    // they'd just start failing every load (their matview is gone, and a live
    // query would hit a table that no longer exists) instead of being cleanly
    // removed. Delete them explicitly: any chart on this dataset directly, plus any
    // chart on a VIEW built on this dataset (about to be deleted below too).
    const { rows: viewRows } = await this.db.query<{ key: string }>(
      `SELECT key FROM reports WHERE dataset_key = $1`, [dataset.key],
    );
    const viewKeys = viewRows.map((r) => r.key);
    const { rows: widgetRows } = await this.db.query<{ id: number }>(
      `SELECT id FROM dashboard_widgets WHERE config->>'dataset' = $1 OR config->>'viewKey' = ANY($2::text[])`,
      [dataset.key, viewKeys],
    );
    for (const { id: widgetId } of widgetRows) {
      await this.db.query(`DROP MATERIALIZED VIEW IF EXISTS mv_chart_${widgetId}`);
      await this.db.query(`DROP MATERIALIZED VIEW IF EXISTS mv_chart_${widgetId}_build`);
      await this.db.query(`DELETE FROM chart_matview_state WHERE widget_id = $1`, [widgetId]);
    }
    if (widgetRows.length) {
      await this.db.query(`DELETE FROM dashboard_widgets WHERE id = ANY($1::int[])`, [widgetRows.map((w) => w.id)]);
    }

    await this.db.query(`DROP TABLE IF EXISTS ${dataset.target_table}`);
    await this.db.query(`DELETE FROM field_mapping WHERE source = $1`, [dataset.key]);
    // Remove this dataset's reports/views (their columns + access cascade).
    await this.db.query(`DELETE FROM reports WHERE dataset_key = $1`, [dataset.key]);
    await this.db.query(`DELETE FROM dataset WHERE id = $1`, [id]); // fields cascade
    this.catalogs.invalidate(dataset.key);
    this.log.log(
      `removed dataset ${dataset.key} (dropped ${dataset.target_table}, ${viewKeys.length} views, ${widgetRows.length} charts)`,
    );
    return { deletedViews: viewKeys.length, deletedCharts: widgetRows.length };
  }
}
