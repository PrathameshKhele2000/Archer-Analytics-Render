import { Logger, Module, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../database/database.module";
import { DatasetsModule } from "../datasets/datasets.module";
import { DatasetSyncService } from "./dataset-sync.service";
import { MssqlSource } from "./mssql.source";
import { SyncController } from "../sync/sync.controller";
import { SyncSourceController } from "./sync-source.controller";

/**
 * The Archer -> Postgres pipes.
 *
 * The sync runs AUTOMATICALLY on a schedule (SYNC_INTERVAL_MINUTES): every active
 * dataset with a source table is pulled incrementally, so nobody has to press a
 * button. The manual "Run sync" endpoint stays for on-demand runs.
 */
@Module({
  imports: [DatabaseModule, CacheModule, DatasetsModule],
  controllers: [SyncSourceController, SyncController],
  providers: [MssqlSource, DatasetSyncService],
  exports: [DatasetSyncService, MssqlSource],
})
export class SyncSourceModule implements OnApplicationBootstrap {
  private readonly log = new Logger(SyncSourceModule.name);

  constructor(
    private readonly sync: DatasetSyncService,
    private readonly source: MssqlSource,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap() {
    if (!this.source.isConfigured()) {
      this.log.warn(
        "MS SQL reporting source not configured (MSSQL_HOST/MSSQL_DATABASE) — automatic sync is idle. " +
          "Fill in the MSSQL_* settings to start pulling Archer data.",
      );
      return;
    }

    const minutes = Math.max(1, this.config.get<number>("syncIntervalMinutes") ?? 15);
    // Node timers are 32-bit: anything over ~24.8 days overflows and fires every 1ms
    // (a runaway sync loop). Clamp it.
    const MAX_TIMER_MS = 2_147_483_647;
    const delayMs = Math.min(minutes * 60_000, MAX_TIMER_MS);

    // Catch up shortly after boot, then keep pulling on the interval — no manual step.
    setTimeout(() => void this.runQuietly(), 15_000);
    const handle = setInterval(() => void this.runQuietly(), delayMs);
    this.scheduler.addInterval("dataset-incremental-sync", handle);

    this.log.log(
      `automatic sync started: every ${(delayMs / 60_000).toFixed(0)} min` +
        (delayMs === MAX_TIMER_MS ? " (clamped from a larger configured value)" : ""),
    );
  }

  /** A scheduled run must never take the app down; failures are recorded per dataset. */
  private async runQuietly() {
    try {
      const results = await this.sync.syncAll(false);
      for (const r of results) {
        if (r.status === "error") this.log.warn(`scheduled sync: ${r.dataset} failed — ${r.error}`);
      }
    } catch (e: any) {
      this.log.error(`scheduled sync failed: ${e?.message ?? e}`);
    }
  }
}
