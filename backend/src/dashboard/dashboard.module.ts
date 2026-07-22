import { Module } from "@nestjs/common";
import { DatasetsModule } from "../datasets/datasets.module";
import { ReportsModule } from "../reports/reports.module";
import { ChartExportService } from "./chart-export.service";
import { DashboardAdminController } from "./dashboard-admin.controller";
import { DashboardController } from "./dashboard.controller";
import { DashboardRepository } from "./dashboard.repository";
import { DashboardService } from "./dashboard.service";

@Module({
  // ReportsModule provides view access + scope for Personalized Dashboard charts.
  imports: [DatasetsModule, ReportsModule], // dataset catalogs drive the chart dimensions/measures
  controllers: [DashboardController, DashboardAdminController],
  providers: [DashboardService, DashboardRepository, ChartExportService],
  exports: [DashboardService],
})
export class DashboardModule {}
