import { BadRequestException } from "@nestjs/common";

export interface DatasetRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  source_table: string | null;
  target_table: string;
  key_column: string;
  watermark_column: string | null;
  is_active: boolean;
  is_protected: boolean;
  default_sort_field: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatasetFieldRow {
  id: number;
  dataset_id: number;
  key: string;
  label: string;
  data_type: DataType;
  is_dimension: boolean;
  is_measurable: boolean;
  is_searchable: boolean;
  is_enabled: boolean;
  sort_order: number;
}

/** The only column types a dataset may declare. */
export const DATA_TYPES = ["text", "integer", "number", "date", "timestamp", "boolean", "json"] as const;
export type DataType = (typeof DATA_TYPES)[number];

const SQL_TYPE: Record<DataType, string> = {
  text: "TEXT",
  integer: "BIGINT",
  number: "NUMERIC",
  date: "DATE",
  timestamp: "TIMESTAMPTZ",
  boolean: "BOOLEAN",
  json: "JSONB",
};

/** Which of our types a SQL Server column maps onto (flat reporting feed -> dataset field). */
export function dataTypeForSqlServer(sqlServerType: string): DataType {
  const t = (sqlServerType ?? "").toLowerCase();
  if (/^(bit)$/.test(t)) return "boolean";
  if (/^(tinyint|smallint|int|bigint)$/.test(t)) return "integer";
  if (/^(decimal|numeric|money|smallmoney|float|real)$/.test(t)) return "number";
  if (/^(date)$/.test(t)) return "date";
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset)$/.test(t)) return "timestamp";
  return "text"; // varchar/nvarchar/char/text/uniqueidentifier/...
}

/** "Device Name" / "Device_Name " -> "device_name" */
export function normalizeKey(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

const DATASET_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const COLUMN_RE = /^[a-z][a-z0-9_]{0,58}$/;

/** Reserved because they're ours, not a dataset's. */
const RESERVED_COLUMNS = new Set(["record_id", "synced_at"]);

/**
 * Identifiers are generated and validated here — never interpolated from raw user
 * input — so the generated DDL cannot be used for injection.
 */
export function assertDatasetKey(key: string): string {
  if (!DATASET_KEY_RE.test(key)) {
    throw new BadRequestException(
      `Invalid dataset key '${key}': use lowercase letters, digits and underscores (2-41 chars, starting with a letter)`,
    );
  }
  return key;
}

export function assertColumn(key: string): string {
  if (!COLUMN_RE.test(key)) {
    throw new BadRequestException(`Invalid column name '${key}': lowercase letters, digits and underscores only`);
  }
  if (RESERVED_COLUMNS.has(key)) {
    throw new BadRequestException(`'${key}' is reserved and is added automatically`);
  }
  return key;
}

export function assertDataType(t: string): DataType {
  if (!DATA_TYPES.includes(t as DataType)) {
    throw new BadRequestException(`Unknown data type '${t}'. Allowed: ${DATA_TYPES.join(", ")}`);
  }
  return t as DataType;
}

/** A dataset's target table is always ds_<key>, so it can never collide with a platform table. */
export function targetTableFor(key: string): string {
  return `ds_${assertDatasetKey(key).replace(/-/g, "_")}`;
}

/** The Postgres column type for one of our data types. */
export function sqlTypeFor(dataType: string): string {
  return SQL_TYPE[assertDataType(dataType)];
}

/**
 * A safe `USING` cast for changing a column to a new type — text/number/date etc.
 * cast the text form; json splits a delimited cell into an array. If existing values
 * are incompatible (e.g. text -> number on non-numbers) the ALTER errors and the
 * caller surfaces a clear message.
 */
export function alterUsingFor(col: string, dataType: DataType): string {
  switch (dataType) {
    case "integer": return `NULLIF(${col}::text,'')::bigint`;
    case "number": return `NULLIF(${col}::text,'')::numeric`;
    case "date": return `NULLIF(${col}::text,'')::date`;
    case "timestamp": return `NULLIF(${col}::text,'')::timestamptz`;
    case "boolean": return `NULLIF(${col}::text,'')::boolean`;
    case "json":
      return `CASE WHEN ${col} IS NULL THEN NULL
                   WHEN left(${col}::text,1) = '[' THEN ${col}::text::jsonb
                   ELSE to_jsonb(array_remove(string_to_array(regexp_replace(${col}::text, '[,;|]', ';', 'g'), ';'), '')) END`;
    default: return `${col}::text`;
  }
}

export interface FieldSpec {
  key: string;
  label: string;
  data_type: DataType;
  is_dimension?: boolean;
  is_measurable?: boolean;
  is_searchable?: boolean;
}

/**
 * The CREATE TABLE for a dataset: an Archer record id primary key (so re-syncing
 * upserts instead of duplicating), one typed column per field, and a synced_at stamp.
 * Dimensions and dates get an index since those are what charts group and sort on.
 */
export function buildCreateTableSql(table: string, fields: FieldSpec[]): string {
  const cols = fields.map((f) => `    ${assertColumn(f.key)} ${SQL_TYPE[assertDataType(f.data_type)]}`);
  const ddl = [
    `CREATE TABLE ${table} (`,
    `    record_id BIGINT PRIMARY KEY,`,
    ...cols.map((c) => `${c},`),
    `    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `);`,
  ];
  for (const f of fields) {
    if (f.is_dimension || f.data_type === "date" || f.data_type === "timestamp") {
      // (column, record_id) — not just (column). The leading column still serves
      // filtering, and the trailing record_id matches the Records list's
      // "ORDER BY <col> <dir>, record_id <dir>" so one index also makes sorting an
      // Index Only Scan. Without the trailing key Postgres sorts the whole table to
      // return one page (measured at 10M rows: 7.6s vs ~13ms).
      ddl.push(`CREATE INDEX ix_${table}_${f.key} ON ${table} (${f.key}, record_id);`);
    }
  }
  return ddl.join("\n");
}
