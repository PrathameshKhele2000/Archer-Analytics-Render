import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { CatalogService } from "./catalog.service";
import { DatasetsController } from "./datasets.controller";
import { DatasetsService } from "./datasets.service";

@Module({
  imports: [DatabaseModule],
  controllers: [DatasetsController],
  providers: [DatasetsService, CatalogService],
  exports: [DatasetsService, CatalogService], // the sync resolves its source/target pairing from here
})
export class DatasetsModule {}
