import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Permissions } from "../common/decorators/permissions.decorator";
import { AuthenticatedUser } from "../auth/jwt-payload.interface";
import { parseColFilters, parseConditions } from "./query-params";
import { ReportsService } from "./reports.service";

@Controller("api/reports")
@Permissions("report:read")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.reports.listForUser(user);
  }

  @Get(":key/config")
  config(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.getConfig(key, user);
  }

  @Get(":key/filters")
  filterOptions(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.filterOptions(key, user);
  }

  /** Advanced-filter field catalog + operators for the query builder. */
  @Get(":key/fields")
  fields(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.getFields(key, user);
  }

  @Get(":key/data")
  data(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("page") pageQ?: string,
    @Query("size") sizeQ?: string,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("sort") sort?: string,
    @Query("order") order?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    const page = Math.max(1, parseInt(pageQ ?? "1", 10) || 1);
    const size = Math.min(50000, Math.max(1, parseInt(sizeQ ?? "100", 10) || 100));
    return this.reports.findings(key, user, {
      page,
      size,
      conditions: parseConditions(filtersJson),
      logic,
      sort,
      order,
      search,
      colFilters: parseColFilters(colsJson),
    });
  }

  @Get(":key/export/csv")
  @Permissions("report:read", "report:export")
  exportCsv(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.reports.exportCsv(key, user, res, { conditions: parseConditions(filtersJson), logic, search, colFilters: parseColFilters(colsJson) });
  }

  @Get(":key/export/excel")
  @Permissions("report:read", "report:export")
  exportExcel(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.reports.exportExcel(key, user, res, { conditions: parseConditions(filtersJson), logic, search, colFilters: parseColFilters(colsJson) });
  }

  @Get(":key/export/pdf")
  @Permissions("report:read", "report:export")
  exportPdf(
    @Param("key") key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.reports.exportPdf(key, user, res, { conditions: parseConditions(filtersJson), logic, search, colFilters: parseColFilters(colsJson) });
  }
}
