import { Module } from "@nestjs/common";
import { DatasetBrowseController } from "../datasets/dataset-browse.controller";
import { DatasetBrowseService } from "../datasets/dataset-browse.service";
import { DatasetsModule } from "../datasets/datasets.module";
import { ExportService } from "./export.service";
import { ReportsAdminController } from "./reports-admin.controller";
import { ReportsController } from "./reports.controller";
import { ReportsRepository } from "./reports.repository";
import { ReportsService } from "./reports.service";

// Dataset browsing lives here rather than in DatasetsModule because it is built on the
// reports paging/streaming engine (ReportsRepository + ExportService). Registering it
// here keeps DatasetsModule free of a dependency on reports, so there's no cycle.
@Module({
  imports: [DatasetsModule],
  controllers: [ReportsController, ReportsAdminController, DatasetBrowseController],
  providers: [ReportsService, ReportsRepository, ExportService, DatasetBrowseService],
  exports: [ReportsService],
})
export class ReportsModule {}
