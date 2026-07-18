import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../auth/jwt-payload.interface";
import { CreateUserDto } from "./dto/create-user.dto";
import { ImportUsersDto } from "./dto/import-users.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UsersService } from "./users.service";

@Controller("api/admin/users")
@Permissions("admin:users:manage")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  /** Bulk import (create-or-update) users from a parsed file. */
  @Post("import")
  import(@Body() dto: ImportUsersDto) {
    return this.users.importUsers(dto.users);
  }

  @Get(":id")
  get(@Param("id", ParseIntPipe) id: number) {
    return this.users.getById(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @CurrentUser() me: AuthenticatedUser) {
    return this.users.remove(id, me.id);
  }
}
