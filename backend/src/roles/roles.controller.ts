import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { CreateRoleDto } from "./dto/create-role.dto";
import { ImportRolesDto } from "./dto/import-roles.dto";
import { SetPermissionsDto } from "./dto/set-permissions.dto";
import { RolesService } from "./roles.service";

@Controller("api/admin/roles")
@Permissions("admin:roles:manage")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list() {
    return this.roles.list();
  }

  @Get("permissions")
  listPermissions() {
    return this.roles.listPermissions();
  }

  /** Bulk import (upsert) roles from a parsed file. */
  @Post("import")
  import(@Body() dto: ImportRolesDto) {
    return this.roles.importRoles(dto.roles);
  }

  @Post()
  create(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @Put(":id/permissions")
  setPermissions(@Param("id", ParseIntPipe) id: number, @Body() dto: SetPermissionsDto) {
    return this.roles.setPermissions(id, dto.permissionIds);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.roles.remove(id);
  }
}
