import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { SaveGroupDto } from "./dto/group.dto";
import { GroupsService } from "./groups.service";

/** Groups are part of Access Control, so they need the same right as editing roles. */
@Controller("api/admin/groups")
@Permissions("admin:roles:manage")
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list() {
    return this.groups.list();
  }

  @Post()
  create(@Body() dto: SaveGroupDto) {
    return this.groups.create(dto);
  }

  @Put(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: SaveGroupDto) {
    return this.groups.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.groups.remove(id);
  }
}
