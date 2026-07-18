import { Controller, Get, Post, Query } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";
import { Permissions } from "../common/decorators/permissions.decorator";
import { DatasetSyncService } from "../sync-source/dataset-sync.service";

/**
 * Sync status/history/run for the Admin → Sync screen.
 *
 * There is exactly ONE sync in this system: the dataset pipes that read the flat
 * Archer reporting feed from MS SQL (SyncSourceModule). It runs automatically on a
 * schedule; these endpoints report on it and allow an on-demand run.
 */
@Controller("api")
export class SyncController {
  constructor(private readonly sync: DatasetSyncService) {}

  @Public()
  @Get("health")
  health() {
    return { status: "ok" };
  }

  /** Per-dataset sync state — one row per pipe. */
  @Get("sync/status")
  @Permissions("sync:read")
  status() {
    return this.sync.status();
  }

  @Get("sync/history")
  @Permissions("sync:read")
  history(@Query("limit") limitQ?: string) {
    return this.sync.history_(Math.min(500, Math.max(1, parseInt(limitQ ?? "50", 10) || 50)));
  }

  /** On-demand run. The scheduler already does this automatically. */
  @Post("sync/run")
  @Permissions("sync:run")
  run(@Query("full") full?: string, @Query("dataset") dataset?: string) {
    const isFull = (full ?? "").toLowerCase() === "true";
    if (dataset) {
      void this.sync.syncDataset(dataset, isFull).catch(() => undefined);
      return { status: "started", dataset, full: isFull };
    }
    void this.sync.syncAll(isFull).catch(() => undefined);
    return { status: "started", full: isFull };
  }
}
