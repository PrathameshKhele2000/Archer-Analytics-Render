import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class MappingRowDto {
  @IsInt()
  id!: number;

  /** null / omitted = ignore this Archer field. */
  @IsString()
  @IsOptional()
  target_column?: string | null;

  @IsString()
  @IsOptional()
  transform?: string;

  @IsBoolean()
  @IsOptional()
  is_enabled?: boolean;
}

export class SaveMappingDto {
  @IsString()
  @IsOptional()
  source?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MappingRowDto)
  rows!: MappingRowDto[];
}
