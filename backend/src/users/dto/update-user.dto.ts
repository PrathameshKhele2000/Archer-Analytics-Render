import { IsArray, IsBoolean, IsEmail, IsInt, IsNotEmpty, IsOptional, MinLength } from "class-validator";

export class UpdateUserDto {
  @IsNotEmpty()
  @IsOptional()
  fullName?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  /** When present, resets the user's password (min 8 chars). Omit to leave it unchanged. */
  @MinLength(8)
  @IsOptional()
  password?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  roleIds?: number[];
}
