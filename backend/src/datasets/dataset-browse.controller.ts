import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { Permissions } from "../common/decorators/permissions.decorator";
import { parseColFilters, parseConditions } from "../reports/query-params";
import { DatasetBrowseService } from "./dataset-browse.service";

/**
 * Browsing registered datasets (the "DataSets" tab). Read-only and separate from
 * /api/admin/datasets, which is where datasets are created and mapped: anyone who can
 * read records can look at the data, but only an admin can change its shape.
 */
@Controller("api/datasets")
@Permissions("report:read")
export class DatasetBrowseController {
  constructor(private readonly datasets: DatasetBrowseService) {}

  @Get()
  list() {
    return this.datasets.list();
  }

  @Get(":key/schema")
  schema(@Param("key") key: string) {
    return this.datasets.schema(key);
  }

  @Get(":key/data")
  data(
    @Param("key") key: string,
    @Query("page") pageQ?: string,
    @Query("size") sizeQ?: string,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("sort") sort?: string,
    @Query("order") order?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.datasets.data(key, {
      page: Math.max(1, parseInt(pageQ ?? "1", 10) || 1),
      size: Math.min(50000, Math.max(1, parseInt(sizeQ ?? "100", 10) || 100)),
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
    @Res() res: Response,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.datasets.exportCsv(key, res, {
      conditions: parseConditions(filtersJson), logic, search, colFilters: parseColFilters(colsJson),
    });
  }

  @Get(":key/export/excel")
  @Permissions("report:read", "report:export")
  exportExcel(
    @Param("key") key: string,
    @Res() res: Response,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.datasets.exportExcel(key, res, {
      conditions: parseConditions(filtersJson), logic, search, colFilters: parseColFilters(colsJson),
    });
  }

  @Get(":key/export/pdf")
  @Permissions("report:read", "report:export")
  exportPdf(
    @Param("key") key: string,
    @Res() res: Response,
    @Query("filters") filtersJson?: string,
    @Query("logic") logic?: string,
    @Query("search") search?: string,
    @Query("cols") colsJson?: string,
  ) {
    return this.datasets.exportPdf(key, res, {
      conditions: parseConditions(filtersJson), logic, search, colFilters: parseColFilters(colsJson),
    });
  }
}
