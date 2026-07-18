import { IsArray, IsInt } from "class-validator";

export class SetPermissionsDto {
  @IsArray()
  @IsInt({ each: true })
  permissionIds!: number[];
}
