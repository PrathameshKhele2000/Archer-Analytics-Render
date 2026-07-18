import { Controller, Get, Post, Query } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { dataTypeForSqlServer } from "../datasets/dataset.entity";
import { DatasetSyncService } from "./dataset-sync.service";
import { MssqlSource } from "./mssql.source";

@Controller("api/admin/source")
export class SyncSourceController {
  constructor(
    private readonly source: MssqlSource,
    private readonly sync: DatasetSyncService,
  ) {}

  /** Is the reporting database reachable? */
  @Get("ping")
  @Permissions("admin:datasets:manage")
  ping() {
    return this.source.ping();
  }

  /** The tables/views we can read — what "pick a source table" offers. */
  @Get("tables")
  @Permissions("admin:datasets:manage")
  tables() {
    return this.source.listTables();
  }

  /**
   * Real column names + types from the feed, already converted to our column types.
   * This is what removes the datatype guesswork when creating a dataset.
   */
  @Get("columns")
  @Permissions("admin:datasets:manage")
  async columns(@Query("table") table: string) {
    const cols = await this.source.describeTable(table);
    return cols.map((c) => ({
      name: c.name,
      sqlType: c.sqlType,
      nullable: c.nullable,
      dataType: dataTypeForSqlServer(c.sqlType), // our column type
    }));
  }

}
