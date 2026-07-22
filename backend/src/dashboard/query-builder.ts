import { BadRequestException } from "@nestjs/common";
import { buildExpressionWhere, FilterCondition } from "../reports/filterable-fields";
import { Catalog, RecordFieldDef } from "../datasets/catalog.service";

/**
 * Safe, Archer-style aggregation engine over the findings dataset.
 *
 * Users NEVER send SQL — they pick keys from these whitelisted catalogs
 * (dimension = X axis / group-by, measure = Y axis value/aggregation). The
 * builder composes a parameterized GROUP BY query from fixed, vetted SQL
 * fragments, so arbitrary field/axis selection stays injection-proof.
 */



export interface ChartTypeDef {
  key: string;
  label: string;
  needsDimension: boolean; // 'number' aggregates over everything, so false
  supportsSeries: boolean; // split/group-by a second dimension
}

// The findings table is a single flat table (mirrors the Archer application fields).



export const CHART_TYPES: Record<string, ChartTypeDef> = {
  column: { key: "column", label: "Column (vertical bars)", needsDimension: true, supportsSeries: true },
  bar: { key: "bar", label: "Bar (horizontal)", needsDimension: true, supportsSeries: true },
  line: { key: "line", label: "Line", needsDimension: true, supportsSeries: true },
  area: { key: "area", label: "Area", needsDimension: true, supportsSeries: true },
  pie: { key: "pie", label: "Pie", needsDimension: true, supportsSeries: false },
  donut: { key: "donut", label: "Donut", needsDimension: true, supportsSeries: false },
  number: { key: "number", label: "Number (single value)", needsDimension: false, supportsSeries: false },
  // Table is a raw records list (not an aggregation): pick columns + filter rows.
  table: { key: "table", label: "Table (records list)", needsDimension: false, supportsSeries: false },
};


/** The columns a table-chart spec resolves to (validated selection, or the default set). */
export function recordChartColumns(spec: ChartSpec, catalog: Catalog): RecordFieldDef[] {
  const fallback = catalog.defaultRecordCols;
  const picked = (spec.tableColumns?.length ? spec.tableColumns : fallback).filter((k) => catalog.recordFields[k]);
  const keys = picked.length ? picked : fallback.filter((k) => catalog.recordFields[k]);
  return keys.map((k) => catalog.recordFields[k]);
}


const MAX_DRILL_LEVELS = 5;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export interface ChartSpec {
  /** Which dataset this chart reads (defaults to the findings dataset). */
  dataset?: string | null;
  /**
   * Personalized dashboards: read through a VIEW the user can access instead of a raw
   * dataset. The server resolves this to the view's dataset and ANDs the view's preset
   * scope into every query, so the chart can only ever see what the view exposes.
   */
  viewKey?: string | null;
  chartType: string;
  // aggregate = Calculate Values | compare = Compare Fields | clause = Group & Count
  mode?: "aggregate" | "compare" | "clause";
  dimension?: string | null; // X axis
  series?: string | null; // legacy single "Group By" (superseded by groupBy)
  groupBy?: string[] | null; // multilevel Group By (aggregate mode) — combined into the series
  compareField?: string | null; // Y-axis field in Compare Fields mode (any dimension, incl. text)
  measure: string; // Y-axis aggregate (aggregate mode); ignored (count) in compare mode
  /**
   * Grouping (clause) mode: how the RECORD COUNTS of the deepest sub-groups are rolled
   * up into each displayed bar. count/sum = total records; avg/min/max = average /
   * smallest / largest records per deepest sub-group under the bar. No field involved —
   * it always operates on record counts.
   */
  groupAgg?: string | null;
  conditions?: FilterCondition[] | null; // numbered filter conditions (shared with reports)
  logic?: string | null; // manual logic expression, e.g. "1 AND (2 OR 3)"
  filters?: Record<string, string> | null; // legacy: dimension-keyed equality (back-compat)
  openOnly?: boolean; // legacy back-compat
  limit?: number | null; // max groups returned
  showLegend?: boolean; // presentation only
  drilldown?: string[] | null; // ordered dimensions to descend into on click
  caption?: string | null; // presentation only ("what vs what")
  tableColumns?: string[] | null; // presentation only: which columns a table chart shows
}

/**
 * Combine a view's preset scope (base) with a chart's own filter (chart) into one
 * numbered-condition set + logic string, ANDing the two. The chart's condition numbers
 * are shifted past the base's so a custom logic expression on either side stays valid.
 * Mirrors how reports AND a view's base scope with the user's filter.
 */
export function mergeScope(
  base: { conditions?: FilterCondition[] | null; logic?: string | null },
  chart: { conditions?: FilterCondition[] | null; logic?: string | null },
): { conditions: FilterCondition[]; logic: string | null } {
  const bc = base.conditions ?? [];
  const cc = chart.conditions ?? [];
  if (!bc.length) return { conditions: cc, logic: chart.logic ?? null };
  if (!cc.length) return { conditions: bc, logic: base.logic ?? null };
  const clause = (logic: string | null | undefined, count: number, offset: number) => {
    const body = logic && logic.trim()
      ? logic.replace(/\d+/g, (m) => String(Number(m) + offset))
      : Array.from({ length: count }, (_, i) => i + 1 + offset).join(" AND ");
    return `(${body})`;
  };
  return {
    conditions: [...bc, ...cc],
    logic: `${clause(base.logic, bc.length, 0)} AND ${clause(chart.logic, cc.length, bc.length)}`,
  };
}

/** The Group By dimensions for a chart (new multilevel array, or the legacy single series). */
function groupByKeys(spec: ChartSpec): string[] {
  if (spec.groupBy && spec.groupBy.length) return spec.groupBy;
  return spec.series ? [spec.series] : [];
}

/**
 * The ordered dimensions a chart drills through. In Grouping (clause) mode the group-by
 * levels themselves are the hierarchy; otherwise it's the base X dimension followed by
 * the configured drill-down path.
 */
export function drillSequence(spec: ChartSpec): string[] {
  if (spec.mode === "clause") return groupByKeys(spec);
  return [spec.dimension, ...(spec.drilldown ?? [])].filter(Boolean) as string[];
}

/** Resolve a chart's filter to {conditions, logic}, converting the legacy dimension-keyed form. */
function specConditions(spec: ChartSpec): { conditions: FilterCondition[]; logic?: string | null } {
  if (spec.conditions && spec.conditions.length) return { conditions: spec.conditions, logic: spec.logic };
  const conds: FilterCondition[] = [];
  for (const [k, v] of Object.entries(spec.filters ?? {})) {
    if (v) conds.push({ field: k, operator: "eq", value: v });
  }
  if (spec.openOnly) conds.push({ field: "is_open", operator: "is_true" });
  return { conditions: conds }; // no logic -> AND all
}

/** Chart WHERE = the user's numbered conditions/logic, ANDed with any drill-down step equalities. */
function buildChartWhere(spec: ChartSpec, catalog: Catalog, drill?: DrillStep[]): { where: string; params: any[] } {
  const { conditions, logic } = specConditions(spec);
  const { where: exprWhere, params } = buildExpressionWhere(conditions, logic, 0, catalog.filterFields);
  const clauses: string[] = [];
  if (exprWhere) clauses.push(exprWhere.replace(/^WHERE /, ""));
  for (const step of drill ?? []) {
    const dim = catalog.dimensions[step.dimension];
    if (!dim) throw new BadRequestException(`Unknown drill-down dimension '${step.dimension}'`);
    // Filter the RAW column when we have one, so the equality can use an index instead
    // of scanning the whole table through the COALESCE expression. '(none)' is the
    // COALESCE fallback for NULL, so it maps to `IS NULL`.
    if (dim.sourceCol) {
      if (step.value === "(none)") {
        clauses.push(`${dim.sourceCol} IS NULL`);
      } else {
        params.push(step.value);
        clauses.push(`${dim.sourceCol} = $${params.length}`);
      }
    } else {
      params.push(step.value);
      clauses.push(`${dim.expr} = $${params.length}`);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function schemaCatalog(catalog: Catalog) {
  return {
    dataset: { key: catalog.key, name: catalog.name },
    dimensions: Object.values(catalog.dimensions).map(({ key, label }) => ({ key, label })),
    measures: Object.values(catalog.measures).map(({ key, label }) => ({ key, label })),
    chartTypes: Object.values(CHART_TYPES),
    filters: Object.values(catalog.dimensions).slice(0, 4).map(({ key, label }) => ({ key, label })),
    recordColumns: Object.values(catalog.recordFields).map(({ key, label, numeric }) => ({ key, label, numeric: !!numeric })),
  };
}

/** Records sort newest-first by the dataset's chosen field, falling back to record id. */
function recordsOrderBy(catalog: Catalog): string {
  return catalog.defaultSort
    ? `f.${catalog.defaultSort} DESC NULLS LAST, f.record_id DESC`
    : `f.record_id DESC`;
}

/**
 * A Table (records list) chart: the selected record columns for rows matching the
 * chart's filters. No aggregation — one row per finding, newest first, capped by limit.
 * Column expressions are whitelisted and filter values parameterized (injection-safe).
 */
export function buildRecordsChartQuery(spec: ChartSpec, catalog: Catalog): { sql: string; params: any[]; columns: RecordFieldDef[] } {
  validateSpec(spec, catalog);
  const columns = recordChartColumns(spec, catalog);
  const { where, params } = buildChartWhere(spec, catalog, []); // conditions/logic only (no drill for a list)
  const limit = resolveLimit(spec.limit);
  const selects = columns.map((c) => `${c.expr} AS ${c.key}`);
  const orderBy = recordsOrderBy(catalog);
  const sql = `
    SELECT ${selects.join(", ")}
    ${catalog.baseFrom}
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;
  return { sql, params, columns };
}

/** Validate a spec against the catalogs; throws 400 on anything unknown/incompatible. */
export function validateSpec(spec: ChartSpec, catalog: Catalog): void {
  const chart = CHART_TYPES[spec.chartType];
  if (!chart) throw new BadRequestException(`Unknown chart type '${spec.chartType}'`);

  // Table = records list: no dimension/measure; just validate the chosen columns.
  if (spec.chartType === "table") {
    for (const k of spec.tableColumns ?? []) {
      if (!catalog.recordFields[k]) throw new BadRequestException(`Unknown table column '${k}'`);
    }
    return;
  }

  if (spec.mode === "clause") {
    // Group & Count: only grouping levels + a measure. No X/Y axis at all.
    // No levels yet (the user just switched into Grouping) is NOT an error — it simply
    // means "no breakdown", and we return the overall total. Throwing here made the live
    // preview 400 the instant the tab was opened.
    const levels = groupByKeys(spec);
    if (levels.length > 4) throw new BadRequestException("At most 4 Group By levels");
    for (const g of levels) {
      if (!catalog.dimensions[g]) throw new BadRequestException(`Unknown Group By dimension '${g}'`);
    }
    if (!catalog.measures[spec.measure]) throw new BadRequestException(`Unknown measure '${spec.measure}'`);
    if (spec.groupAgg && !GROUP_AGGS.has(spec.groupAgg)) {
      throw new BadRequestException(`Unknown grouping aggregation '${spec.groupAgg}'`);
    }
  } else if (spec.mode === "compare") {
    // Compare Fields: X field × Y field, value = count. Y (compareField) becomes the series.
    if (!chart.supportsSeries) {
      throw new BadRequestException("Compare Fields needs a column, bar, line, area or table chart");
    }
    if (!spec.dimension || !catalog.dimensions[spec.dimension]) {
      throw new BadRequestException("Compare Fields needs an X-axis field");
    }
    if (!spec.compareField || !catalog.dimensions[spec.compareField]) {
      throw new BadRequestException("Compare Fields needs a Y-axis field");
    }
  } else {
    // Calculate Values: X dimension + aggregate measure (+ optional multilevel Group By).
    if (!catalog.measures[spec.measure]) throw new BadRequestException(`Unknown measure '${spec.measure}'`);
    if (chart.needsDimension) {
      if (!spec.dimension) throw new BadRequestException(`Chart type '${spec.chartType}' needs an X-axis field`);
      if (!catalog.dimensions[spec.dimension]) throw new BadRequestException(`Unknown dimension '${spec.dimension}'`);
    }
    const groupKeys = groupByKeys(spec);
    if (groupKeys.length) {
      if (!chart.supportsSeries) throw new BadRequestException(`Chart type '${spec.chartType}' does not support Group By`);
      if (groupKeys.length > 4) throw new BadRequestException("At most 4 Group By levels");
      for (const g of groupKeys) {
        if (!catalog.dimensions[g]) throw new BadRequestException(`Unknown Group By dimension '${g}'`);
      }
    }
  }
  if (spec.drilldown) {
    if (spec.drilldown.length > MAX_DRILL_LEVELS) {
      throw new BadRequestException(`At most ${MAX_DRILL_LEVELS} drill-down levels`);
    }
    for (const d of spec.drilldown) {
      if (!catalog.dimensions[d]) throw new BadRequestException(`Unknown drill-down dimension '${d}'`);
    }
  }
}

function resolveLimit(limit?: number | null): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export interface DrillStep {
  dimension: string;
  value: string;
}

interface AggOpts {
  dimensionOverride?: string; // group by this dimension instead of spec.dimension (drill level)
  dropSeries?: boolean; // drop split-by (used while drilling)
  drill?: DrillStep[]; // extra equality filters from drill clicks
}

/** Compose the aggregation SQL. Returns rows shaped as {x, series?, y}. */
function buildAggregationCore(spec: ChartSpec, catalog: Catalog, opts: AggOpts = {}): { sql: string; params: any[] } {
  validateSpec(spec, catalog);
  const chart = CHART_TYPES[spec.chartType];
  const isCompare = spec.mode === "compare";
  // Every mode uses the chosen aggregate (Compare Fields used to be hard-wired to a
  // record count, which made it impossible to compare sums/averages across two fields).
  const measureExpr = (catalog.measures[spec.measure] ?? catalog.measures.count).expr;
  const { where, params } = buildChartWhere(spec, catalog, opts.drill);
  const limit = resolveLimit(spec.limit);

  // ---- Clause (Grouping): the group-by levels form a DRILL HIERARCHY. The base chart
  // shows the FIRST level; clicking a bar/slice descends to the next level, filtered by
  // the clicked value (see buildDrill). So it renders like an ordinary single-dimension
  // chart — clickable and drillable — instead of a wall of "A / B / C" composite bars.
  const clauseLevels = spec.mode === "clause" ? groupByKeys(spec) : null;

  // No grouping dimension in play — aggregate 'number', or Grouping with zero levels —
  // means a single overall value.
  const noDimension = clauseLevels
    ? clauseLevels.length === 0 && !opts.dimensionOverride
    : !chart.needsDimension && !opts.dimensionOverride;
  if (noDimension) {
    return { sql: `SELECT ${measureExpr} AS y ${catalog.baseFrom} ${where}`, params };
  }

  const dimKey = opts.dimensionOverride ?? (clauseLevels ? clauseLevels[0] : spec.dimension);

  // Grouping with avg/min/max: those roll up the record counts of the DEEPEST
  // sub-groups, so the live query nests — inner counts every (g0..gN) combination,
  // outer rolls the displayed level up from those counts. (count/sum equal a plain
  // count(*) per bar and keep the simpler single-level query below.)
  if (clauseLevels) {
    const agg = groupAggOf(spec);
    if (agg === "avg" || agg === "min" || agg === "max") {
      const li = Math.max(0, clauseLevels.indexOf(dimKey!));
      const exprs = clauseLevels.map((k, i) => `${catalog.dimensions[k].expr} AS g${i}`);
      const { reaggExpr } = clauseMeasureParts(spec);
      return {
        sql: `
    SELECT g${li} AS x, ${reaggExpr.replace(/_v/g, "cnt")} AS y
    FROM (
      SELECT ${exprs.join(", ")}, count(*) AS cnt
      ${catalog.baseFrom}
      ${where}
      GROUP BY ${clauseLevels.map((k) => catalog.dimensions[k].expr).join(", ")}
    ) sub
    GROUP BY g${li}
    ORDER BY g${li}
    LIMIT ${limit}
  `,
        params,
      };
    }
  }

  const dim = catalog.dimensions[dimKey!];
  const selectCols = [`${dim.expr} AS x`];
  const groupCols = [dim.expr];
  // Compare mode: Y field is the series. Aggregate mode: one or more Group By levels,
  // combined into a single "A / B / C" series label. Clause is a drill hierarchy — one
  // level at a time — so it never carries a split series.
  const seriesKeys: string[] = (opts.dropSeries || clauseLevels)
    ? []
    : isCompare
      ? spec.compareField ? [spec.compareField] : []
      : groupByKeys(spec);
  if (seriesKeys.length) {
    const exprs = seriesKeys.map((k) => catalog.dimensions[k].expr);
    selectCols.push(`concat_ws(' / ', ${exprs.join(", ")}) AS series`);
    groupCols.push(...exprs);
  }
  selectCols.push(`${measureExpr} AS y`);
  const orderBy = dim.order ?? dim.expr;

  const sql = `
    SELECT ${selectCols.join(", ")}
    ${catalog.baseFrom}
    ${where}
    GROUP BY ${groupCols.join(", ")}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;
  return { sql, params };
}

export function buildAggregation(spec: ChartSpec, catalog: Catalog): { sql: string; params: any[] } {
  return buildAggregationCore(spec, catalog);
}

/** Safe SQL literal for inlining a validated, parameterized value into a matview definition. */
function inlineLiteral(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`; // single-quote escaped
}

/**
 * Aggregation SQL with filter values inlined as literals (no $ params) so it can back
 * a CREATE MATERIALIZED VIEW. Field expressions are whitelisted and values are escaped,
 * so this stays injection-safe.
 */
export function buildAggregationInline(spec: ChartSpec, catalog: Catalog): string {
  const { sql, params } = buildAggregationCore(spec, catalog);
  return sql.replace(/\$(\d+)/g, (_m, n) => inlineLiteral(params[Number(n) - 1]));
}

/** Safety cap on distinct group combinations a clause matview stores. */
const CLAUSE_MATVIEW_CAP = 200_000;

/** The roll-ups Grouping offers over sub-group record counts. */
const GROUP_AGGS = new Set(["count", "sum", "avg", "min", "max"]);

/** The chart's groupAgg, defaulting to a plain record count. */
export function groupAggOf(spec: ChartSpec): string {
  return spec.groupAgg && GROUP_AGGS.has(spec.groupAgg) ? spec.groupAgg : "count";
}

/**
 * How a Grouping chart's value is stored in the matview and rolled up when reading any
 * level. The matview holds the DEEPEST breakdown — one row per (g0..gN) combination
 * with its record count — and every aggregation operates on those COUNTS (no field):
 *   - count / sum → total records under the bar        (sum of sub-group counts)
 *   - avg         → average records per deepest sub-group (avg is NOT additive, which
 *                   is exactly why the matview stores the raw per-combination counts)
 *   - min / max   → smallest / largest sub-group count
 */
export function clauseMeasureParts(spec: ChartSpec): { valueCols: string; reaggExpr: string } {
  const valueCols = `count(*) AS _v`;
  switch (groupAggOf(spec)) {
    case "avg": return { valueCols, reaggExpr: `round(avg(_v), 1)` };
    case "min": return { valueCols, reaggExpr: `min(_v)` };
    case "max": return { valueCols, reaggExpr: `max(_v)` };
    default:    return { valueCols, reaggExpr: `sum(_v)` }; // count & sum: total records
  }
}

/**
 * Matview definition for a Grouping (clause) chart: the FULL multi-level breakdown —
 * one row per (g0, g1, …, gN) combination with the measure's re-aggregatable components.
 * Small (the product of the levels' cardinalities), so the base chart and every drill
 * level then re-aggregate this tiny table instead of scanning the 10M-row source. Inline
 * literals so it can back a CREATE MATERIALIZED VIEW; expressions are whitelisted and
 * values escaped. Returns null when there are no levels (nothing to pre-aggregate).
 */
export function buildClauseMatviewInline(spec: ChartSpec, catalog: Catalog): string | null {
  validateSpec(spec, catalog);
  const levels = groupByKeys(spec);
  if (!levels.length) return null;
  const { valueCols } = clauseMeasureParts(spec);
  const { where, params } = buildChartWhere(spec, catalog); // chart's own filter only (no drill)
  const exprs = levels.map((k) => catalog.dimensions[k].expr);
  const cols = exprs.map((e, i) => `${e} AS g${i}`);
  cols.push(valueCols);
  const sql = `
    SELECT ${cols.join(", ")}
    ${catalog.baseFrom}
    ${where}
    GROUP BY ${exprs.join(", ")}
    LIMIT ${CLAUSE_MATVIEW_CAP}
  `;
  return sql.replace(/\$(\d+)/g, (_m, n) => inlineLiteral(params[Number(n) - 1]));
}

/**
 * Given a saved chart spec and the accumulated clicks, produce the next drill
 * level's query. The step path is validated against the chart's own predefined
 * sequence [dimension, ...drilldown] — clients cannot inject arbitrary levels.
 */
export function buildDrill(
  spec: ChartSpec,
  catalog: Catalog,
  steps: DrillStep[],
): { sql: string; params: any[]; dimension: string | null; atLeaf: boolean } {
  // In Grouping mode the group-by levels ARE the drill hierarchy; otherwise it's the
  // base dimension plus the configured drill-down path.
  const sequence = drillSequence(spec);
  steps.forEach((step, i) => {
    if (step.dimension !== sequence[i]) {
      throw new BadRequestException("Drill path does not match this chart's drill-down sequence");
    }
  });
  const level = steps.length;
  const levelDim = sequence[level] ?? null;
  if (!levelDim) return { sql: "", params: [], dimension: null, atLeaf: true };

  const { sql, params } = buildAggregationCore(spec, catalog, {
    dimensionOverride: levelDim,
    dropSeries: true,
    drill: steps,
  });
  return { sql, params, dimension: levelDim, atLeaf: level + 1 >= sequence.length };
}


/**
 * Underlying records for a chart, filtered by the chart's own filters AND the full
 * drill path (every clicked value). Used to show the raw findings behind the last
 * drill level. Values are parameterized; step dimensions come from the whitelist.
 */
export function buildRecordsQuery(
  spec: ChartSpec,
  catalog: Catalog,
  steps: DrillStep[],
  limit = 200,
): { sql: string; params: any[] } {
  const { where, params } = buildChartWhere(spec, catalog, steps);
  const cappedLimit = Math.min(1000, Math.max(1, limit));
  const recordCols = Object.values(catalog.recordFields).map((c) => `${c.expr} AS ${c.key}`).join(", ");
  const orderBy = recordsOrderBy(catalog);

  // These drill columns are low-cardinality (a handful of distinct values), so neither a
  // bitmap-AND of their indexes (lossy, rechecks millions of rows) nor an `ORDER BY <date>
  // LIMIT` index scan (scans most of the table) is fast. Instead grab a sample of matching
  // rows with a bare LIMIT — a seq scan that STOPS as soon as it has enough — then order
  // just that sample for display. Measured: ~25s -> well under a second. (The sample is
  // representative rather than the strict newest-N, which is the right trade for a
  // "records behind this selection" peek.)
  const sql = `
    SELECT ${recordCols}
    FROM (SELECT * ${catalog.baseFrom} ${where} LIMIT ${cappedLimit}) f
    ORDER BY ${orderBy}
  `;
  return { sql, params };
}
