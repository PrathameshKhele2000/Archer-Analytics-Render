import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { MssqlSource } from "../sync-source/mssql.source";
import { CatalogService } from "./catalog.service";
import { DatasetsController } from "./datasets.controller";
import { DatasetsService } from "./datasets.service";

// MssqlSource is also provided by SyncSourceModule, which itself imports this
// module (for CatalogService/DatasetsService) — importing SyncSourceModule here
// would be circular, so it's registered again as its own instance. It's just a
// lazily-connecting read-only pool, so a second instance is harmless.
@Module({
  imports: [DatabaseModule],
  controllers: [DatasetsController],
  providers: [DatasetsService, CatalogService, MssqlSource],
  exports: [DatasetsService, CatalogService], // the sync resolves its source/target pairing from here
})
export class DatasetsModule {}
