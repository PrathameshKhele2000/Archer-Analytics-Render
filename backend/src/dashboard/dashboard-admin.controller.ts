import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { DashboardService } from "./dashboard.service";
import {
  CreateDashboardDto,
  CreateWidgetDto,
  GrantAccessDto,
  UpdateDashboardDto,
  UpdateWidgetDto,
} from "./dto/dashboard.dto";

@Controller("api/admin/dashboards")
@Permissions("admin:dashboards:manage")
export class DashboardAdminController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get()
  list() {
    return this.dashboards.listAll();
  }

  @Post()
  create(@Body() dto: CreateDashboardDto) {
    return this.dashboards.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateDashboardDto) {
    return this.dashboards.update(id, dto);
  }

  @Post(":id/widgets")
  addWidget(@Param("id", ParseIntPipe) id: number, @Body() dto: CreateWidgetDto) {
    return this.dashboards.addWidget(id, dto);
  }

  @Patch(":id/widgets/:widgetId")
  updateWidget(
    @Param("id", ParseIntPipe) id: number,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @Body() dto: UpdateWidgetDto,
  ) {
    return this.dashboards.updateWidget(id, widgetId, dto);
  }

  @Delete(":id/widgets/:widgetId")
  deleteWidget(@Param("id", ParseIntPipe) id: number, @Param("widgetId", ParseIntPipe) widgetId: number) {
    return this.dashboards.deleteWidget(id, widgetId);
  }

  @Get(":id/access")
  listAccess(@Param("id", ParseIntPipe) id: number) {
    return this.dashboards.listAccess(id);
  }

  @Post(":id/access")
  grantAccess(@Param("id", ParseIntPipe) id: number, @Body() dto: GrantAccessDto) {
    return this.dashboards.grantAccess(id, dto);
  }

  @Delete(":id/access/:accessId")
  revokeAccess(@Param("accessId", ParseIntPipe) accessId: number) {
    return this.dashboards.revokeAccess(accessId);
  }
}
