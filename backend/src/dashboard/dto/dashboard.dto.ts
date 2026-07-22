import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateDashboardDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class UpdateDashboardDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

const WIDGET_TYPES = ["kpi", "donut", "bar", "line", "stacked_bar", "table"] as const;

export class CreateWidgetDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsIn(WIDGET_TYPES)
  widgetType!: (typeof WIDGET_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  dataSource!: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

export class UpdateWidgetDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsIn(WIDGET_TYPES)
  @IsOptional()
  widgetType?: (typeof WIDGET_TYPES)[number];

  @IsString()
  @IsOptional()
  dataSource?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

export class GrantAccessDto {
  @IsInt()
  @IsOptional()
  roleId?: number;

  @IsInt()
  @IsOptional()
  userId?: number;
}

/** Create a personal (initially empty) dashboard; charts are added inside it. */
export class CreateMyDashboardDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;
}

export class UpdateMyDashboardDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;
}

/**
 * A chart specification (Archer-style): chart type + X-axis field (dimension) +
 * Y-axis value (measure) + optional split-by series + filters. Only keys are
 * accepted; the backend validates them against the query-builder catalog.
 */
export class ChartSpecDto {
  /** Which dataset this chart reads; omitted = the findings dataset. */
  @IsString()
  @IsOptional()
  dataset?: string | null;

  /** Personalized Dashboard: read through this view (resolved to its dataset + scope). */
  @IsString()
  @IsOptional()
  viewKey?: string | null;

  @IsString()
  @IsNotEmpty()
  chartType!: string;

  @IsIn(["aggregate", "compare", "clause"])
  @IsOptional()
  mode?: "aggregate" | "compare" | "clause";

  @IsString()
  @IsOptional()
  dimension?: string | null;

  @IsString()
  @IsOptional()
  series?: string | null; // legacy single Group By

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  groupBy?: string[] | null; // multilevel Group By (aggregate mode)

  @IsString()
  @IsOptional()
  compareField?: string | null; // Y-axis field (compare mode)

  @IsString()
  @IsNotEmpty()
  measure!: string;

  /** Grouping mode: roll-up of sub-group record counts (no field involved). */
  @IsIn(["count", "sum", "avg", "min", "max"])
  @IsOptional()
  groupAgg?: string | null;

  @IsArray()
  @IsOptional()
  conditions?: any[] | null; // numbered filter conditions (validated server-side)

  @IsString()
  @IsOptional()
  logic?: string | null; // manual logic expression, e.g. "1 AND (2 OR 3)"

  @IsObject()
  @IsOptional()
  filters?: Record<string, string> | null; // legacy, back-compat

  @IsBoolean()
  @IsOptional()
  openOnly?: boolean;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  limit?: number | null;

  @IsBoolean()
  @IsOptional()
  showLegend?: boolean;

  /** Colour palette the chart draws with. Presentation only — never touches the SQL. */
  @IsIn(["default", "ocean", "forest", "sunset", "berry", "slate", "vivid"])
  @IsOptional()
  theme?: string | null;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  @IsOptional()
  drilldown?: string[] | null;

  @IsString()
  @IsOptional()
  caption?: string | null;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tableColumns?: string[] | null; // presentation only: which columns a table chart shows
}

export class DrillStepDto {
  @IsString()
  @IsNotEmpty()
  dimension!: string;

  @IsString()
  value!: string;
}

export class DrillDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DrillStepDto)
  steps!: DrillStepDto[];
}

/** Drill one step deeper into an UNSAVED spec (live preview in the chart designer). */
export class PreviewDrillDto {
  @ValidateNested()
  @Type(() => ChartSpecDto)
  spec!: ChartSpecDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DrillStepDto)
  steps!: DrillStepDto[];
}

export class ChartExportDto {
  @IsIn(["pdf", "excel"])
  format!: "pdf" | "excel";

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsOptional()
  caption?: string;

  @IsArray()
  headers!: string[];

  @IsArray()
  rows!: (string | number | null)[][];

  @IsString()
  @IsOptional()
  image?: string; // data URL of the rendered chart (for PDF)
}

export class AddChartWidgetDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ValidateNested()
  @Type(() => ChartSpecDto)
  spec!: ChartSpecDto;
}

export class UpdateChartWidgetDto {
  @IsString()
  @IsOptional()
  title?: string;

  @ValidateNested()
  @Type(() => ChartSpecDto)
  @IsOptional()
  spec?: ChartSpecDto;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}
