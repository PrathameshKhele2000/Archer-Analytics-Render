import { IsOptional, IsString } from "class-validator";

/** Edit a role's name and/or description. Access grants are set separately. */
export class UpdateRoleDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
