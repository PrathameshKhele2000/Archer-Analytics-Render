import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsEmail, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";

/** One row of a bulk user import. Roles are referenced by name (resolved server-side). */
export class ImportUserDto {
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  fullName!: string;

  @IsString()
  @IsOptional()
  bu?: string;

  @IsString()
  @IsOptional()
  sbu?: string;

  @IsString()
  @IsOptional()
  password?: string; // if omitted for a new user, a temp password is generated and returned

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  roles?: string[]; // role names
}

export class ImportUsersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportUserDto)
  users!: ImportUserDto[];
}
