import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { ReportsService } from "./reports.service";
import {
  CreateReportDto,
  GrantReportAccessDto,
  SaveViewDto,
  UpdateReportDto,
  UpsertColumnDto,
  UpsertFilterDto,
} from "./dto/report.dto";

@Controller("api/admin/reports")
@Permissions("admin:reports:manage")
export class ReportsAdminController {
  constructor(private readonly reports: ReportsService) {}

  // ---- Record Views: a view = preset filter + columns + role access ----
  // Declared before ':id' routes so "views" isn't parsed as an id.

  @Get("datasets")
  datasets() {
    return this.reports.listDatasets();
  }

  @Get("dataset-schema")
  datasetSchema(@Query("dataset") dataset?: string) {
    return this.reports.datasetSchema(dataset || "archer-findings");
  }

  @Post("match-count")
  matchCount(@Body() body: { datasetKey?: string; conditions?: any[]; logic?: string | null }) {
    return this.reports.matchCount(body.datasetKey || "archer-findings", body.conditions ?? [], body.logic);
  }

  @Get("views")
  listViews() {
    return this.reports.listViews();
  }

  @Post("views")
  createView(@Body() dto: SaveViewDto) {
    return this.reports.createView(dto);
  }

  @Put("views/:id")
  updateView(@Param("id", ParseIntPipe) id: number, @Body() dto: SaveViewDto) {
    return this.reports.updateView(id, dto);
  }

  @Delete("views/:id")
  deleteView(@Param("id", ParseIntPipe) id: number) {
    return this.reports.deleteView(id);
  }

  @Get()
  list() {
    return this.reports.listAll();
  }

  @Post()
  create(@Body() dto: CreateReportDto) {
    return this.reports.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateReportDto) {
    return this.reports.update(id, dto);
  }

  @Post(":id/columns")
  upsertColumn(@Param("id", ParseIntPipe) id: number, @Body() dto: UpsertColumnDto) {
    return this.reports.upsertColumn(id, dto);
  }

  @Delete("columns/:columnId")
  deleteColumn(@Param("columnId", ParseIntPipe) columnId: number) {
    return this.reports.deleteColumn(columnId);
  }

  @Post(":id/filters")
  upsertFilter(@Param("id", ParseIntPipe) id: number, @Body() dto: UpsertFilterDto) {
    return this.reports.upsertFilter(id, dto);
  }

  @Delete("filters/:filterId")
  deleteFilter(@Param("filterId", ParseIntPipe) filterId: number) {
    return this.reports.deleteFilter(filterId);
  }

  @Get(":id/access")
  listAccess(@Param("id", ParseIntPipe) id: number) {
    return this.reports.listAccess(id);
  }

  @Post(":id/access")
  grantAccess(@Param("id", ParseIntPipe) id: number, @Body() dto: GrantReportAccessDto) {
    return this.reports.grantAccess(id, dto);
  }

  @Delete(":id/access/:accessId")
  revokeAccess(@Param("accessId", ParseIntPipe) accessId: number) {
    return this.reports.revokeAccess(accessId);
  }
}
