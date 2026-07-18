import { Module } from "@nestjs/common";
import { DatasetsModule } from "../datasets/datasets.module";
import { ExportService } from "./export.service";
import { ReportsAdminController } from "./reports-admin.controller";
import { ReportsController } from "./reports.controller";
import { ReportsRepository } from "./reports.repository";
import { ReportsService } from "./reports.service";

@Module({
  imports: [DatasetsModule],
  controllers: [ReportsController, ReportsAdminController],
  providers: [ReportsService, ReportsRepository, ExportService],
  exports: [ReportsService],
})
export class ReportsModule {}
