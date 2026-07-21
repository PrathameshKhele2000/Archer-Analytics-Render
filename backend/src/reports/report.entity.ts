import { FilterField } from "./filterable-fields";

export interface ReportRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  data_source: string;
  /** Which dataset this view reads (its columns/filters come from that catalog). */
  dataset_key: string;
  is_active: boolean;
  /** Preset scope of this view — ANDed with the user's own filters. */
  base_conditions: any[];
  base_logic: string | null;
  /** Rows to show: null = every matching row; N = only the top N in the view's sort. */
  row_limit: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * Everything the report query engine needs for ONE dataset — built from that
 * dataset's catalog, so the register/views run against any dataset (not just
 * findings). All identifiers come from the catalog (validated), never raw input.
 */
export interface ReportContext {
  table: string;                          // the dataset's table, e.g. "fact_findings"
  baseFrom: string;                       // e.g. "FROM ds_devices f"
  searchable: Record<string, string>;     // column key -> SQL expr (cast to text)
  sortable: Record<string, string>;       // column key -> SQL expr
  filterFields: Record<string, FilterField>;
  selectCols: { key: string; expr: string }[]; // the view's columns
  defaultSortExpr: string;                // newest-first fallback
}

export interface ReportColumnRow {
  id: number;
  report_id: number;
  key: string;
  label: string;
  sortable: boolean;
  is_default_visible: boolean;
  sort_order: number;
}

export interface ReportFilterRow {
  id: number;
  report_id: number;
  key: string;
  label: string;
  filter_type: "select" | "text" | "boolean" | "date_range";
  source: string | null;
  sort_order: number;
}

export interface ReportAccessRow {
  id: number;
  report_id: number;
  role_id: number | null;
  user_id: number | null;
}

// (The report query shape is now built per dataset from its catalog — see
//  ReportContext above and CatalogService. There are no hardcoded findings columns.)
