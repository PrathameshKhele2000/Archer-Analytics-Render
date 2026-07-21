import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class SaveGroupDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Roles every member of this group inherits. */
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  roleIds?: number[];

  /** Users in the group. */
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  userIds?: number[];
}
