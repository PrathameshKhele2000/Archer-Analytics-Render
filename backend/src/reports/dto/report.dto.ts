import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateIf, ValidateNested } from "class-validator";

export class CreateReportDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  dataSource?: string;
}

export class UpdateReportDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpsertColumnDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsBoolean()
  @IsOptional()
  sortable?: boolean;

  @IsBoolean()
  @IsOptional()
  isDefaultVisible?: boolean;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

const FILTER_TYPES = ["select", "text", "boolean", "date_range"] as const;

export class UpsertFilterDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsIn(FILTER_TYPES)
  filterType!: (typeof FILTER_TYPES)[number];

  @IsString()
  @IsOptional()
  source?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class GrantReportAccessDto {
  @IsInt()
  @IsOptional()
  roleId?: number;

  @IsInt()
  @IsOptional()
  userId?: number;
}

/** Create/update a Record View: preset scope + columns + which roles see it. */
export class ViewColumnDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  label!: string;
}

export class SaveViewDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  /** Which dataset this view reads (defaults to the findings dataset). */
  @IsString()
  @IsOptional()
  datasetKey?: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Preset scope — validated against the filter catalog on save. */
  @IsArray()
  @IsOptional()
  baseConditions?: any[];

  @IsString()
  @IsOptional()
  baseLogic?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ViewColumnDto)
  @IsOptional()
  columns?: ViewColumnDto[];

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  roleIds?: number[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  /** Rows to show: omit/null for all matching rows, or N for only the top N. */
  @IsInt()
  @Min(1)
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  rowLimit?: number | null;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}
