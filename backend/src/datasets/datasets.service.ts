import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DbService } from "../database/db.service";
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
  sqlTypeFor,
  targetTableFor,
} from "./dataset.entity";
import { CatalogService } from "./catalog.service";
import { CreateDatasetDto, UpdateDatasetDto } from "./dto/dataset.dto";

@Injectable()
export class DatasetsService {
  private readonly log = new Logger(DatasetsService.name);

  constructor(private readonly db: DbService, private readonly catalogs: CatalogService) {}

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

  /** Normalize + validate a submitted field list; throws 400 on anything unusable. */
  private resolveFields(dto: CreateDatasetDto): FieldSpec[] {
    if (!dto.fields?.length) throw new BadRequestException("Add at least one field");
    const seen = new Set<string>();
    return dto.fields.map((f, i) => {
      const key = assertColumn(normalizeKey(f.key || f.label));
      if (seen.has(key)) throw new BadRequestException(`Duplicate column '${key}'`);
      seen.add(key);
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

    await this.db.query(buildCreateTableSql(targetTable, fields));
    this.log.log(`created dataset table ${targetTable} (${fields.length} fields)`);

    const { rows } = await this.db.query<DatasetRow>(
      `INSERT INTO dataset (key, name, description, source_table, target_table, key_column, watermark_column)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        key, dto.name.trim(), dto.description ?? null,
        dto.sourceTable ?? null, targetTable,
        dto.keyColumn || "ContentId", dto.watermarkColumn || null,
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
      const desired = dto.fields
        .filter((f) => (f.label ?? "").trim() && (f.key ?? "") !== "record_id")
        .map((f) => ({
          key: assertColumn(f.key?.trim() || normalizeKey(f.label)),
          label: f.label.trim(),
          data_type: assertDataType(f.data_type),
          is_dimension: !!f.is_dimension, is_measurable: !!f.is_measurable, is_searchable: !!f.is_searchable,
        }));
      const seen = new Set<string>();
      for (const f of desired) { if (seen.has(f.key)) throw new BadRequestException(`Duplicate column '${f.key}'`); seen.add(f.key); }

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
  async importRows(id: number, rows: Record<string, any>[], keyColumn?: string): Promise<{ loaded: number }> {
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

    let loaded = 0;
    // Upsert in batches to keep statements a sensible size.
    for (let start = 0; start < rows.length; start += 500) {
      const batch = rows.slice(start, start + 500);
      const params: any[] = [];
      const tuples: string[] = [];
      batch.forEach((row, i) => {
        const rid = keyColumn && row[keyColumn] != null && String(row[keyColumn]).trim() !== ""
          ? parseInt(String(row[keyColumn]).replace(/[^\d-]/g, ""), 10)
          : start + i + 1; // no id column -> sequential row number
        if (Number.isNaN(rid)) return;
        const vals = [rid, ...fields.map((f) => convert(row[f.label], f.data_type))];
        const base = params.length;
        params.push(...vals);
        tuples.push(`(${vals.map((_, j) => `$${base + j + 1}`).join(",")})`);
      });
      if (!tuples.length) continue;
      const updates = fields.map((f) => `${f.key} = EXCLUDED.${f.key}`).join(", ");
      await this.db.query(
        `INSERT INTO ${dataset.target_table} (${cols.join(",")}) VALUES ${tuples.join(",")}
         ON CONFLICT (record_id) DO UPDATE SET ${updates}, synced_at = now()`,
        params,
      );
      loaded += tuples.length;
    }
    this.log.log(`imported ${loaded} rows into ${dataset.target_table} from CSV`);
    return { loaded };
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
    if (dataset.is_protected) {
      throw new BadRequestException(`'${dataset.name}' is a built-in dataset and cannot be removed`);
    }
    if (!/^ds_[a-z0-9_]+$/.test(dataset.target_table)) {
      throw new BadRequestException(`Refusing to drop '${dataset.target_table}': not a generated dataset table`);
    }
    await this.db.query(`DROP TABLE IF EXISTS ${dataset.target_table}`);
    await this.db.query(`DELETE FROM field_mapping WHERE source = $1`, [dataset.key]);
    // Remove this dataset's reports/views (their columns + access cascade).
    await this.db.query(`DELETE FROM reports WHERE dataset_key = $1`, [dataset.key]);
    await this.db.query(`DELETE FROM dataset WHERE id = $1`, [id]); // fields cascade
    this.catalogs.invalidate(dataset.key);
    this.log.log(`removed dataset ${dataset.key} (dropped ${dataset.target_table}, its reports)`);
  }
}
