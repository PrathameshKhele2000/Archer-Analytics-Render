import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { CreateRoleDto } from "./dto/create-role.dto";
import { ImportRolesDto } from "./dto/import-roles.dto";
import { SetPermissionsDto } from "./dto/set-permissions.dto";
import { SetResourcesDto } from "./dto/set-resources.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";
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

  /** Everything a role can be granted read access to, for the Access Control pickers. */
  @Get("resources")
  listResources() {
    return this.roles.listGrantableResources();
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

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto.name, dto.description);
  }

  @Put(":id/permissions")
  setPermissions(@Param("id", ParseIntPipe) id: number, @Body() dto: SetPermissionsDto) {
    return this.roles.setPermissions(id, dto.permissionIds);
  }

  /** Grant this role READ access to a set of views and/or dashboards. */
  @Put(":id/resources")
  setResources(@Param("id", ParseIntPipe) id: number, @Body() dto: SetResourcesDto) {
    return this.roles.setResources(id, dto.viewIds, dto.dashboardIds);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.roles.remove(id);
  }
}
