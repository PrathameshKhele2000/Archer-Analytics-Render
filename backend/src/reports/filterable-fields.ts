import { BadRequestException } from "@nestjs/common";

/**
 * Advanced filter engine for the findings report. Users pick a field, an operator
 * (constrained to the field's type), and value(s). Field keys map to fixed, vetted
 * SQL expressions and every value is parameterized — so arbitrary field/operator/value
 * selection stays injection-proof.
 */

export type FieldType = "text" | "number" | "date" | "datetime" | "time" | "enum" | "boolean";

export interface FilterField {
  key: string;
  label: string;
  type: FieldType;
  expr: string; // whitelisted SQL expression
  enumSource?: string; // dim to pull selectable values from (for enum fields)
}

export interface FilterCondition {
  field: string;
  operator: string;
  value?: string;
  value2?: string; // for range operators (between)
  values?: string[]; // for list operators (in / not in)
}

// arity: 0 = no value, 1 = single value, 2 = range (value+value2), -1 = list (values[])
export interface OperatorDef {
  op: string;
  label: string;
  arity: 0 | 1 | 2 | -1;
}

export const FILTER_FIELDS: Record<string, FilterField> = {
  // Dropdown (pick-list) fields — options come from the dropdown_option table.
  age: { key: "age", label: "Age", type: "enum", expr: "f.age", enumSource: "age" },
  priority: { key: "priority", label: "Priority", type: "enum", expr: "f.priority", enumSource: "priority" },
  device_status: { key: "device_status", label: "Device status", type: "enum", expr: "f.device_status", enumSource: "device_status" },
  cve_type: { key: "cve_type", label: "CVE type", type: "enum", expr: "f.cve_type", enumSource: "cve_type" },
  reassign_vulnerability: { key: "reassign_vulnerability", label: "Reassign vulnerability", type: "enum", expr: "f.reassign_vulnerability", enumSource: "reassign_vulnerability" },
  // Text fields.
  record_status: { key: "record_status", label: "Record status", type: "text", expr: "f.record_status" },
  cve: { key: "cve", label: "CVE", type: "text", expr: "f.cve" },
  device_name: { key: "device_name", label: "Device name", type: "text", expr: "f.device_name" },
  computer_name: { key: "computer_name", label: "Computer name", type: "text", expr: "f.computer_name" },
  asset_id: { key: "asset_id", label: "Asset ID", type: "text", expr: "f.asset_id" },
  detection_id: { key: "detection_id", label: "Detection ID", type: "text", expr: "f.detection_id" },
  device_ip_address: { key: "device_ip_address", label: "Device IP address", type: "text", expr: "f.device_ip_address" },
  crowdstrike_device_os: { key: "crowdstrike_device_os", label: "CrowdStrike device OS", type: "text", expr: "f.crowdstrike_device_os" },
  details: { key: "details", label: "Details", type: "text", expr: "f.details" },
  comments: { key: "comments", label: "Comments", type: "text", expr: "f.comments" },
  // Multi-value (JSON) fields — matched as text (contains / equals on the stored list).
  business_unit: { key: "business_unit", label: "Business unit", type: "text", expr: "f.business_unit::text" },
  application_owner: { key: "application_owner", label: "Application owner", type: "text", expr: "f.application_owner::text" },
  os_engineering_owner: { key: "os_engineering_owner", label: "OS engineering owner", type: "text", expr: "f.os_engineering_owner::text" },
  os_patching_owner: { key: "os_patching_owner", label: "OS patching owner", type: "text", expr: "f.os_patching_owner::text" },
  // Numeric.
  days_open: { key: "days_open", label: "Days open", type: "number", expr: "f.days_open" },
  // Dates.
  first_found_date: { key: "first_found_date", label: "First found date", type: "date", expr: "f.first_found_date" },
  first_published: { key: "first_published", label: "First published", type: "date", expr: "f.first_published" },
  closed_date: { key: "closed_date", label: "Closed date", type: "date", expr: "f.closed_date" },
  last_updated: { key: "last_updated", label: "Last updated", type: "datetime", expr: "f.last_updated" },
};

const TEXT_OPS: OperatorDef[] = [
  { op: "contains", label: "contains", arity: 1 },
  { op: "not_contains", label: "does not contain", arity: 1 },
  { op: "eq", label: "equals", arity: 1 },
  { op: "neq", label: "not equal to", arity: 1 },
  { op: "starts_with", label: "starts with", arity: 1 },
  { op: "ends_with", label: "ends with", arity: 1 },
  { op: "empty", label: "is empty", arity: 0 },
  { op: "not_empty", label: "is not empty", arity: 0 },
];
const NUMBER_OPS: OperatorDef[] = [
  { op: "eq", label: "=", arity: 1 },
  { op: "neq", label: "≠", arity: 1 },
  { op: "gt", label: ">", arity: 1 },
  { op: "gte", label: "≥", arity: 1 },
  { op: "lt", label: "<", arity: 1 },
  { op: "lte", label: "≤", arity: 1 },
  { op: "between", label: "between", arity: 2 },
  { op: "empty", label: "is empty", arity: 0 },
  { op: "not_empty", label: "is not empty", arity: 0 },
];
const DATE_OPS: OperatorDef[] = [
  { op: "on", label: "on", arity: 1 },
  { op: "before", label: "before", arity: 1 },
  { op: "after", label: "after", arity: 1 },
  { op: "between", label: "between", arity: 2 },
  { op: "empty", label: "is empty", arity: 0 },
  { op: "not_empty", label: "is not empty", arity: 0 },
];
const ENUM_OPS: OperatorDef[] = [
  { op: "eq", label: "is", arity: 1 },
  { op: "neq", label: "is not", arity: 1 },
  { op: "in", label: "is any of", arity: -1 },
  { op: "not_in", label: "is none of", arity: -1 },
  { op: "empty", label: "is empty", arity: 0 },
  { op: "not_empty", label: "is not empty", arity: 0 },
];
const BOOLEAN_OPS: OperatorDef[] = [
  { op: "is_true", label: "is true", arity: 0 },
  { op: "is_false", label: "is false", arity: 0 },
];

export const OPERATORS: Record<FieldType, OperatorDef[]> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  date: DATE_OPS,
  datetime: DATE_OPS,
  time: DATE_OPS,
  enum: ENUM_OPS,
  boolean: BOOLEAN_OPS,
};

function castFor(type: FieldType): string {
  if (type === "datetime") return "timestamptz";
  if (type === "time") return "time";
  return "date";
}

/**
 * Build one SQL clause for a condition, pushing params. Returns null to skip (missing value).
 * `paramOffset` lets a second expression continue another one's placeholder numbering
 * (a view's preset filter is ANDed with the user's own filter in one statement).
 */
function buildClause(
  field: FilterField,
  op: OperatorDef,
  cond: FilterCondition,
  params: any[],
  paramOffset = 0,
): string | null {
  const expr = field.expr;
  const p = (v: any): string => {
    params.push(v);
    return `$${paramOffset + params.length}`;
  };
  const num = (v?: string): number => {
    const n = Number(v);
    if (v === undefined || v === "" || Number.isNaN(n)) throw new BadRequestException(`Invalid number for '${field.key}'`);
    return n;
  };

  /**
   * An operator reads exactly one operand shape: `value` (arity 1), `value` + `value2`
   * (2), `values[]` (-1), or nothing (0). A condition that carries its operand in a
   * DIFFERENT slot used to fall through to "no value supplied" and be dropped — the
   * filter then vanished and the query returned everything, with no error.
   *
   * That is only ever a caller mistake, so it is now rejected. A condition whose own
   * slot is simply still empty is a different thing — a half-typed row in the builder —
   * and is skipped as before, so the live preview keeps working while you type.
   */
  const hasText = (v?: string) => v !== undefined && v !== "";
  const stray: string[] = [];
  if (op.arity !== -1 && (cond.values?.length ?? 0) > 0) stray.push("values");
  if (op.arity !== 2 && hasText(cond.value2)) stray.push("value2");
  if (op.arity !== 1 && op.arity !== 2 && hasText(cond.value)) stray.push("value");
  if (stray.length) {
    throw new BadRequestException(
      `Operator '${op.op}' on '${field.key}' does not take ${stray.join("/")}` +
      `${op.arity === -1 ? " — use values[]" : op.arity === 0 ? " — it takes no value" : " — use value"}`,
    );
  }

  // Operators that need no value.
  switch (op.op) {
    case "empty":
      return field.type === "text" || field.type === "enum"
        ? `(${expr} IS NULL OR ${expr}::text = '')`
        : `${expr} IS NULL`;
    case "not_empty":
      return field.type === "text" || field.type === "enum"
        ? `(${expr} IS NOT NULL AND ${expr}::text <> '')`
        : `${expr} IS NOT NULL`;
    case "is_true":
      return `${expr} IS TRUE`;
    case "is_false":
      return `${expr} IS FALSE`;
  }

  // List operators (enum in / not in).
  if (op.op === "in" || op.op === "not_in") {
    const list = (cond.values ?? []).filter((v) => v !== "");
    if (!list.length) return null;
    const clause = `${expr} = ANY(${p(list)}::text[])`;
    return op.op === "in" ? clause : `NOT (${clause})`;
  }

  // Range operator (between).
  if (op.op === "between") {
    if (field.type === "number") {
      return `${expr} BETWEEN ${p(num(cond.value))} AND ${p(num(cond.value2))}`;
    }
    if (cond.value === undefined || cond.value === "" || cond.value2 === undefined || cond.value2 === "") return null;
    const c = castFor(field.type);
    return `${expr} BETWEEN ${p(cond.value)}::${c} AND ${p(cond.value2)}::${c}`;
  }

  // Single-value operators.
  if (cond.value === undefined || cond.value === "") return null;

  switch (field.type) {
    case "text":
    case "enum":
      switch (op.op) {
        case "contains": return `${expr} ILIKE ${p(`%${cond.value}%`)}`;
        case "not_contains": return `${expr} NOT ILIKE ${p(`%${cond.value}%`)}`;
        case "eq": return `${expr} = ${p(cond.value)}`;
        case "neq": return `${expr} IS DISTINCT FROM ${p(cond.value)}`;
        case "starts_with": return `${expr} ILIKE ${p(`${cond.value}%`)}`;
        case "ends_with": return `${expr} ILIKE ${p(`%${cond.value}`)}`;
      }
      break;
    case "number":
      switch (op.op) {
        case "eq": return `${expr} = ${p(num(cond.value))}`;
        case "neq": return `${expr} <> ${p(num(cond.value))}`;
        case "gt": return `${expr} > ${p(num(cond.value))}`;
        case "gte": return `${expr} >= ${p(num(cond.value))}`;
        case "lt": return `${expr} < ${p(num(cond.value))}`;
        case "lte": return `${expr} <= ${p(num(cond.value))}`;
      }
      break;
    case "date":
    case "datetime":
    case "time": {
      const c = castFor(field.type);
      const lhs = op.op === "on" && field.type === "datetime" ? `${expr}::date` : expr;
      const rc = op.op === "on" ? (field.type === "datetime" ? "date" : c) : c;
      switch (op.op) {
        case "on": return `${lhs} = ${p(cond.value)}::${rc}`;
        case "before": return `${expr} < ${p(cond.value)}::${c}`;
        case "after": return `${expr} > ${p(cond.value)}::${c}`;
      }
      break;
    }
  }
  throw new BadRequestException(`Operator '${op.op}' is not valid for field '${field.key}'`);
}

// ---- Numbered conditions + a manual logic expression (e.g. "1 AND (2 OR 3) AND NOT 4") ----

const MAX_CONDITIONS = 100;

type Tok =
  | { type: "NUM"; value: number; raw: string }
  | { type: "AND" | "OR" | "NOT" | "LP" | "RP"; raw: string };

function tokenizeLogic(expr: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(") { tokens.push({ type: "LP", raw: "(" }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "RP", raw: ")" }); i++; continue; }
    if (/[0-9]/.test(ch)) {
      let n = "";
      while (i < expr.length && /[0-9]/.test(expr[i])) n += expr[i++];
      tokens.push({ type: "NUM", value: parseInt(n, 10), raw: n });
      continue;
    }
    if (/[a-zA-Z&|!]/.test(ch)) {
      let w = "";
      while (i < expr.length && /[a-zA-Z&|!]/.test(expr[i])) w += expr[i++];
      const u = w.toUpperCase();
      if (u === "AND" || u === "&&" || u === "&") tokens.push({ type: "AND", raw: w });
      else if (u === "OR" || u === "||" || u === "|") tokens.push({ type: "OR", raw: w });
      else if (u === "NOT" || u === "!") tokens.push({ type: "NOT", raw: w });
      else throw new BadRequestException(`Unexpected token '${w}' in logic expression`);
      continue;
    }
    throw new BadRequestException(`Unexpected character '${ch}' in logic expression`);
  }
  return tokens;
}

/**
 * Recursive-descent parse of the logic expression into SQL, resolving each number
 * to its pre-built (parameterized) clause. Grammar (NOT > AND > OR):
 *   expr := term (OR term)* ; term := factor (AND factor)* ; factor := NOT factor | '(' expr ')' | NUMBER
 */
function parseLogic(expr: string, count: number, buildOne: (n: number) => string): string {
  const tokens = tokenizeLogic(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  const parseExpr = (): string => {
    let left = parseTerm();
    while (peek()?.type === "OR") { eat(); left = `(${left} OR ${parseTerm()})`; }
    return left;
  };
  const parseTerm = (): string => {
    let left = parseFactor();
    while (peek()?.type === "AND") { eat(); left = `(${left} AND ${parseFactor()})`; }
    return left;
  };
  const parseFactor = (): string => {
    const t = peek();
    if (!t) throw new BadRequestException("Unexpected end of logic expression");
    if (t.type === "NOT") { eat(); return `NOT ${parseFactor()}`; }
    if (t.type === "LP") {
      eat();
      const e = parseExpr();
      if (peek()?.type !== "RP") throw new BadRequestException("Missing ')' in logic expression");
      eat();
      return `(${e})`;
    }
    if (t.type === "NUM") {
      eat();
      if (t.value < 1 || t.value > count) {
        throw new BadRequestException(`Logic refers to condition ${t.value}, which does not exist`);
      }
      return buildOne(t.value); // builds the clause + pushes its params on demand
    }
    throw new BadRequestException(`Unexpected token '${t.raw}' in logic expression`);
  };

  const result = parseExpr();
  if (pos < tokens.length) throw new BadRequestException(`Unexpected token '${peek().raw}' in logic expression`);
  return result;
}

/**
 * Build the WHERE from a flat, numbered list of conditions plus an optional manual
 * logic expression combining them by number (AND / OR / NOT / parentheses). An empty
 * expression defaults to ANDing all conditions.
 *
 * Clauses are built lazily as the logic references them, so params are pushed only
 * for referenced conditions (a condition omitted from the logic contributes no param).
 */
export function buildExpressionWhere(
  conditions: FilterCondition[],
  logic?: string | null,
  paramOffset = 0,
  /** Field catalog to resolve against — a dataset's own fields, or the findings default. */
  fields: Record<string, FilterField> = FILTER_FIELDS,
): { where: string; params: any[] } {
  const conds = conditions ?? [];
  if (conds.length > MAX_CONDITIONS) throw new BadRequestException(`At most ${MAX_CONDITIONS} conditions`);

  // Validate every condition's field/operator up front (even if not referenced).
  const meta = conds.map((cond) => {
    const field = fields[cond.field];
    if (!field) throw new BadRequestException(`Unknown field '${cond.field}'`);
    const op = OPERATORS[field.type].find((o) => o.op === cond.operator);
    if (!op) throw new BadRequestException(`Operator '${cond.operator}' not valid for ${field.type} field '${cond.field}'`);
    return { field, op, cond };
  });

  const params: any[] = [];
  const buildOne = (n: number): string => {
    const { field, op, cond } = meta[n - 1];
    return buildClause(field, op, cond, params, paramOffset) ?? "TRUE"; // incomplete condition -> no-op
  };

  const expr = (logic ?? "").trim();
  let sql: string;
  if (!expr) {
    const active: string[] = [];
    for (let i = 1; i <= meta.length; i++) {
      const c = buildOne(i);
      if (c !== "TRUE") active.push(c);
    }
    if (!active.length) return { where: "", params: [] };
    sql = active.join(" AND ");
  } else {
    sql = parseLogic(expr, meta.length, buildOne);
  }
  return { where: sql ? `WHERE ${sql}` : "", params };
}

/** Field catalog for the builder UI (without enum options, which the service fills in). */
export function fieldCatalog() {
  return {
    operators: OPERATORS,
    fields: Object.values(FILTER_FIELDS).map((f) => ({ key: f.key, label: f.label, type: f.type, enumSource: f.enumSource })),
  };
}
