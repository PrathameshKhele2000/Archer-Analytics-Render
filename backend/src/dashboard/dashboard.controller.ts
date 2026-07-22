import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Permissions } from "../common/decorators/permissions.decorator";
import { AuthenticatedUser } from "../auth/jwt-payload.interface";
import { ChartExportService } from "./chart-export.service";
import { DashboardService } from "./dashboard.service";
import {
  AddChartWidgetDto,
  ChartExportDto,
  ChartSpecDto,
  CreateMyDashboardDto,
  DrillDto,
  GrantAccessDto,
  PreviewDrillDto,
  UpdateChartWidgetDto,
  UpdateMyDashboardDto,
} from "./dto/dashboard.dto";

@Controller("api/dashboards")
export class DashboardController {
  constructor(
    private readonly dashboards: DashboardService,
    private readonly chartExport: ChartExportService,
  ) {}

  @Get()
  @Permissions("dashboard:read")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboards.listForUser(user);
  }

  /** Export a chart: PDF (rendered chart image + data table) or Excel (data). */
  @Post("charts/export")
  @Permissions("dashboard:read")
  chartExportFile(@Body() dto: ChartExportDto, @Res() res: Response) {
    return dto.format === "excel" ? this.chartExport.excel(res, dto) : this.chartExport.pdf(res, dto);
  }

  /** Builder catalog: available X-axis fields, Y-axis measures, chart types, filters. */
  @Get("schema")
  @Permissions("dashboard:create")
  schema(
    @CurrentUser() user: AuthenticatedUser,
    @Query("dataset") dataset?: string,
    @Query("view") view?: string,
  ) {
    return this.dashboards.schema(dataset, view, user);
  }

  /** Live chart preview — runs an unsaved spec and returns the aggregated rows. */
  @Post("query-preview")
  @Permissions("dashboard:create")
  preview(@CurrentUser() user: AuthenticatedUser, @Body() spec: ChartSpecDto) {
    return this.dashboards.previewQuery(spec, user);
  }

  /** Live preview of a drill step, so the designer can click through before saving. */
  @Post("query-preview/drill")
  @Permissions("dashboard:create")
  previewDrill(@CurrentUser() user: AuthenticatedUser, @Body() dto: PreviewDrillDto) {
    return this.dashboards.previewDrill(dto.spec, dto.steps, user);
  }

  @Post()
  @Permissions("dashboard:create")
  createMine(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMyDashboardDto) {
    return this.dashboards.createMine(user, dto);
  }

  @Patch(":key")
  @Permissions("dashboard:create")
  updateMine(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyDashboardDto,
  ) {
    return this.dashboards.updateMine(key, user, dto);
  }

  @Delete(":key")
  @Permissions("dashboard:create")
  deleteMine(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dashboards.deleteMine(key, user);
  }

  @Post(":key/share")
  @Permissions("dashboard:create")
  shareMine(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GrantAccessDto,
  ) {
    return this.dashboards.shareMine(key, user, dto);
  }

  // ---- Charts on an owned dashboard ----

  @Post(":key/charts")
  @Permissions("dashboard:create")
  addChart(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddChartWidgetDto,
  ) {
    return this.dashboards.addChart(key, user, dto);
  }

  @Patch(":key/charts/:widgetId")
  @Permissions("dashboard:create")
  updateChart(
    @Param("key") key: string,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateChartWidgetDto,
  ) {
    return this.dashboards.updateChart(key, widgetId, user, dto);
  }

  @Delete(":key/charts/:widgetId")
  @Permissions("dashboard:create")
  removeChart(
    @Param("key") key: string,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dashboards.removeChart(key, widgetId, user);
  }

  /** Drill one level down a chart (read access is enough; path is validated server-side). */
  @Post(":key/charts/:widgetId/drill")
  @Permissions("dashboard:read")
  drill(
    @Param("key") key: string,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DrillDto,
  ) {
    return this.dashboards.drill(key, widgetId, user, dto.steps);
  }

  /** Raw records behind a chart at the deepest drill level (the leaf table). */
  @Post(":key/charts/:widgetId/records")
  @Permissions("dashboard:read")
  chartRecords(
    @Param("key") key: string,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DrillDto,
  ) {
    return this.dashboards.chartRecords(key, widgetId, user, dto.steps);
  }

  @Get(":key")
  @Permissions("dashboard:read")
  getOne(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dashboards.getWithData(key, user);
  }
}
