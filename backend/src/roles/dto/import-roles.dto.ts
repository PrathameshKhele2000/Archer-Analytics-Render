import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";

/** One row of a bulk role import. Permissions are referenced by code (resolved server-side). */
export class ImportRoleDto {
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[]; // permission codes, e.g. 'dashboard:read'
}

export class ImportRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportRoleDto)
  roles!: ImportRoleDto[];
}
