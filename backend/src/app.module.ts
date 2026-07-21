import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AuditModule } from "./audit/audit.module";
import { AuditInterceptor } from "./audit/audit.interceptor";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "./auth/guards/permissions.guard";
import { CacheModule } from "./cache/cache.module";
import configuration from "./config/configuration";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DatabaseModule } from "./database/database.module";
import { DatasetsModule } from "./datasets/datasets.module";
import { MappingModule } from "./mapping/mapping.module";
import { ReportsModule } from "./reports/reports.module";
import { GroupsModule } from "./groups/groups.module";
import { RolesModule } from "./roles/roles.module";
import { SyncSourceModule } from "./sync-source/sync-source.module";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    CacheModule,
    AuthModule,
    UsersModule,
    RolesModule,
    GroupsModule,
    AuditModule,
    DashboardModule,
    ReportsModule,
    MappingModule,
    DatasetsModule,
    SyncSourceModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
