import { IsArray, IsEmail, IsInt, IsNotEmpty, IsOptional, MinLength } from "class-validator";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @MinLength(8)
  password!: string;

  @IsNotEmpty()
  fullName!: string;

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  roleIds?: number[];
}
