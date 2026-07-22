import { IsArray, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @MinLength(8)
  password!: string;

  @IsNotEmpty()
  fullName!: string;

  /** Business Unit / Sub Business Unit — optional, free text. */
  @IsString()
  @MaxLength(120)
  @IsOptional()
  bu?: string;

  @IsString()
  @MaxLength(120)
  @IsOptional()
  sbu?: string;

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  roleIds?: number[];
}
