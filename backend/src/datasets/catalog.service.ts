import { BadRequestException, Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import { DatasetFieldRow, DatasetRow } from "./dataset.entity";
import { FieldType, FilterField, OPERATORS } from "../reports/filterable-fields";

export interface DimensionDef { key: string; label: string; expr: string; order?: string }
export interface MeasureDef { key: string; label: string; expr: string }
export interface RecordFieldDef { key: string; label: string; expr: string; numeric?: boolean }

/** Everything the query engine needs to build SQL for one dataset. */
export interface Catalog {
  key: string;
  name: string;
  table: string;
  baseFrom: string;
  dimensions: Record<string, DimensionDef>;
  measures: Record<string, MeasureDef>;
  recordFields: Record<string, RecordFieldDef>;
  filterFields: Record<string, FilterField>;
  defaultRecordCols: string[];
  /** Field a records list sorts by (newest-first); null -> record_id. */
  defaultSort: string | null;
  searchable: Record<string, string>;
  sortable: Record<string, string>;
}

interface MeasureRow {
  key: string; label: string; agg: string;
  field_key: string | null; filter_field: string | null; filter_mode: string | null;
}

const AGGS = new Set(["count", "sum", "avg", "min", "max"]);
const ID_RE = /^[a-z][a-z0-9_]{0,58}$/;

/** Identifiers come from our own registry, but validate anyway before they reach SQL. */
function ident(s: string): string {
  if (!ID_RE.test(s)) throw new BadRequestException(`Unsafe identifier '${s}' in dataset catalog`);
  return s;
}
const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

/** Date fields name their buckets off the base: first_found_date -> first_found_month. */
const bucketBase = (key: string) => key.replace(/_date$/, "");

const titleize = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Builds a dataset's query catalog from its registry rows — the dimensions, measures,
 * filter fields and record columns that used to be hardcoded for findings. Cached,
 * since it only changes when an admin edits the dataset.
 */
@Injectable()
export class CatalogService {
  private cache = new Map<string, Catalog>();

  constructor(private readonly db: DbService) {}

  invalidate(key?: string) {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  async listDatasets(): Promise<{ key: string; name: string }[]> {
    const { rows } = await this.db.query<{ key: string; name: string }>(
      `SELECT key, name FROM dataset WHERE is_active ORDER BY is_protected DESC, name`,
    );
    return rows;
  }

  async forDataset(key: string): Promise<Catalog> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const { rows: dsRows } = await this.db.query<DatasetRow>(`SELECT * FROM dataset WHERE key = $1`, [key]);
    const ds = dsRows[0];
    if (!ds) throw new BadRequestException(`Unknown dataset '${key}'`);

    const [{ rows: fields }, { rows: measures }, { rows: opts }] = await Promise.all([
      this.db.query<DatasetFieldRow>(
        `SELECT * FROM dataset_field WHERE dataset_id = $1 AND is_enabled ORDER BY sort_order, key`, [ds.id]),
      this.db.query<MeasureRow>(
        `SELECT key,label,agg,field_key,filter_field,filter_mode FROM dataset_measure
         WHERE dataset_id = $1 ORDER BY sort_order, key`, [ds.id]),
      // Pick-list ordering, so a dropdown dimension sorts naturally (Red, High, Yellow, Green).
      // Scoped to this dataset — Devices' "device_status" is not Findings' "device_status".
      this.db.query<{ field_key: string; value: string; sort_order: number }>(
        `SELECT field_key, value, sort_order FROM dropdown_option WHERE dataset_key = $1 ORDER BY field_key, sort_order`,
        [key]),
    ]);

    const table = ident(ds.target_table);
    const catalog: Catalog = {
      key: ds.key, name: ds.name, table,
      baseFrom: `FROM ${table} f`,
      dimensions: {}, measures: {}, recordFields: {}, filterFields: {},
      defaultRecordCols: [], defaultSort: ds.default_sort_field ? ident(ds.default_sort_field) : null,
      searchable: {}, sortable: {},
    };

    const orderByOptions = (fieldKey: string, expr: string): string | undefined => {
      const list = opts.filter((o) => o.field_key === fieldKey);
      if (!list.length) return undefined;
      const whens = list.map((o) => `WHEN ${lit(o.value)} THEN ${Number(o.sort_order) || 0}`).join(" ");
      return `CASE ${expr} ${whens} ELSE 999 END`;
    };

    // record_id is the primary key on every dataset table (not a dataset_field),
    // so expose it as a record column so lists can always show/sort by it.
    catalog.recordFields["record_id"] = { key: "record_id", label: "Record ID", expr: "f.record_id", numeric: true };
    catalog.searchable["record_id"] = "f.record_id::text";
    catalog.sortable["record_id"] = "f.record_id";

    for (const f of fields) {
      const col = ident(f.key);
      const ref = `f.${col}`;
      const label = f.label || titleize(col);

      // ---- record columns (the Records list / table chart) ----
      catalog.recordFields[col] = {
        key: col, label, expr: ref,
        numeric: f.data_type === "integer" || f.data_type === "number",
      };
      // Search expression. For text, use the RAW column (no coalesce/cast) so the
      // trigram GIN index can serve `col ILIKE '%term%'` — wrapping it in coalesce()
      // or ::text hides the column from the planner and forces a full seq scan.
      if (f.is_searchable) catalog.searchable[col] = f.data_type === "text" ? ref : `${ref}::text`;
      catalog.sortable[col] = ref;

      // ---- dimensions (chart X axis / Group By) ----
      if (f.is_dimension) {
        const expr = f.data_type === "json" ? `COALESCE(${ref}->>0, '(none)')` : `COALESCE(${ref}, '(none)')`;
        catalog.dimensions[col] = { key: col, label, expr, order: orderByOptions(col, expr) };
      }
      // Date fields get month/year buckets automatically.
      if (f.data_type === "date" || f.data_type === "timestamp") {
        const base = bucketBase(col);
        catalog.dimensions[`${base}_month`] = {
          key: `${base}_month`, label: `${label} month`, expr: `to_char(${ref}, 'YYYY-MM')`,
        };
        catalog.dimensions[`${base}_year`] = {
          key: `${base}_year`, label: `${label} year`, expr: `to_char(${ref}, 'YYYY')`,
        };
      }

      // ---- generated measures for numeric fields ----
      if (f.is_measurable && (f.data_type === "integer" || f.data_type === "number")) {
        catalog.measures[`sum_${col}`] = { key: `sum_${col}`, label: `Total ${label.toLowerCase()}`, expr: `round(sum(${ref}), 1)` };
        catalog.measures[`avg_${col}`] = { key: `avg_${col}`, label: `Avg ${label.toLowerCase()}`, expr: `round(avg(${ref}), 1)` };
        catalog.measures[`min_${col}`] = { key: `min_${col}`, label: `Min ${label.toLowerCase()}`, expr: `min(${ref})` };
        catalog.measures[`max_${col}`] = { key: `max_${col}`, label: `Max ${label.toLowerCase()}`, expr: `max(${ref})` };
      }

      // ---- filter fields ----
      // A field with pick-list options filters as an enum (so 'is any of' etc. work);
      // this must match what fieldCatalogFor reports to the UI.
      const hasOptions = opts.some((o) => o.field_key === col);
      catalog.filterFields[col] = {
        key: col, label,
        type: hasOptions ? "enum" : this.filterTypeFor(f.data_type),
        expr: f.data_type === "json" ? `${ref}::text` : ref,
        enumSource: hasOptions ? col : undefined,
      };
    }

    // Safety net: if a dataset has NOTHING flagged searchable, the only entry here is
    // record_id — and global search then builds an empty OR list, silently drops the
    // term and returns every row ("search does nothing"). Fall back to every text-ish
    // column so search always actually searches, whatever the registry flags say.
    const hasSearchableField = Object.keys(catalog.searchable).some((k) => k !== "record_id");
    if (!hasSearchableField) {
      for (const f of fields) {
        if (f.data_type !== "text" && f.data_type !== "json") continue;
        const col = ident(f.key);
        catalog.searchable[col] = f.data_type === "text" ? `f.${col}` : `f.${col}::text`;
      }
    }

    // count(*) is always available.
    catalog.measures.count = { key: "count", label: "Number of records", expr: "count(*)" };

    // Registry-defined measures (business rules like "Open findings").
    for (const m of measures) {
      if (!AGGS.has(m.agg)) continue;
      const inner = m.agg === "count" ? "*" : `f.${ident(m.field_key!)}`;
      let expr = m.agg === "count" ? `count(*)` : `round(${m.agg}(${inner}), 1)`;
      if (m.filter_field && (m.filter_mode === "is_null" || m.filter_mode === "is_not_null")) {
        const test = m.filter_mode === "is_null" ? "IS NULL" : "IS NOT NULL";
        expr += ` FILTER (WHERE f.${ident(m.filter_field)} ${test})`;
      }
      catalog.measures[m.key] = { key: m.key, label: m.label, expr };
    }

    catalog.defaultRecordCols = fields.slice(0, 8).map((f) => f.key);

    this.cache.set(key, catalog);
    return catalog;
  }

  private filterTypeFor(dataType: string): FieldType {
    switch (dataType) {
      case "integer":
      case "number": return "number";
      case "date": return "date";
      case "timestamp": return "datetime";
      case "boolean": return "boolean";
      default: return "text";
    }
  }

  /** Filter catalog for the builder UI: fields + their operators + pick-list options. */
  async fieldCatalogFor(key: string) {
    const catalog = await this.forDataset(key);
    const { rows } = await this.db.query<{ field_key: string; value: string }>(
      `SELECT field_key, value FROM dropdown_option WHERE dataset_key = $1 ORDER BY field_key, sort_order`,
      [key],
    );
    const byField = new Map<string, string[]>();
    for (const r of rows) byField.set(r.field_key, [...(byField.get(r.field_key) ?? []), r.value]);

    return {
      operators: OPERATORS,
      fields: Object.values(catalog.filterFields).map((f) => ({
        key: f.key, label: f.label,
        // A pick-list field filters as an enum so the UI offers its values.
        type: (byField.has(f.key) ? "enum" : f.type) as FieldType,
        options: byField.get(f.key),
      })),
    };
  }
}
