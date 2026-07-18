import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";

export class DatasetFieldDto {
  @IsString()
  @IsOptional()
  key?: string; // derived from label when omitted

  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsString()
  @IsNotEmpty()
  data_type!: string; // validated against DATA_TYPES in the service

  @IsBoolean()
  @IsOptional()
  is_dimension?: boolean;

  @IsBoolean()
  @IsOptional()
  is_measurable?: boolean;

  @IsBoolean()
  @IsOptional()
  is_searchable?: boolean;
}

export class CreateDatasetDto {
  @IsString()
  @IsOptional()
  key?: string; // derived from name when omitted

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** The flat reporting table this dataset reads from, e.g. 'dbo.ArcherDevicesFeed'. */
  @IsString()
  @IsOptional()
  sourceTable?: string;

  @IsString()
  @IsOptional()
  keyColumn?: string;

  @IsString()
  @IsOptional()
  watermarkColumn?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DatasetFieldDto)
  fields!: DatasetFieldDto[];
}

export class UpdateDatasetDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  sourceTable?: string;

  @IsString()
  @IsOptional()
  keyColumn?: string;

  @IsString()
  @IsOptional()
  watermarkColumn?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DatasetFieldDto)
  @IsOptional()
  fields?: DatasetFieldDto[];
}
