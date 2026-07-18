import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { DATA_TYPES } from "./dataset.entity";
import { DatasetsService } from "./datasets.service";
import { CreateDatasetDto, UpdateDatasetDto } from "./dto/dataset.dto";

@Controller("api/admin/datasets")
@Permissions("admin:datasets:manage")
export class DatasetsController {
  constructor(private readonly datasets: DatasetsService) {}

  @Get()
  list() {
    return this.datasets.list();
  }

  /** The column types a dataset field may declare (drives the UI dropdown). */
  @Get("data-types")
  dataTypes() {
    return DATA_TYPES;
  }

  @Get(":id/fields")
  fields(@Param("id", ParseIntPipe) id: number) {
    return this.datasets.fields(id);
  }

  /** Show the exact CREATE TABLE that Create would run — nothing is changed. */
  @Post("preview")
  preview(@Body() dto: CreateDatasetDto) {
    return this.datasets.previewSql(dto);
  }

  @Post()
  create(@Body() dto: CreateDatasetDto) {
    return this.datasets.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateDatasetDto) {
    return this.datasets.update(id, dto);
  }

  /** Load parsed CSV rows into a dataset's table (for datasets without a live feed). */
  @Post(":id/import")
  importRows(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { rows: Record<string, any>[]; keyColumn?: string },
  ) {
    return this.datasets.importRows(id, body.rows ?? [], body.keyColumn);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.datasets.remove(id);
  }
}
