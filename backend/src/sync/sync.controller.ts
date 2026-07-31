import { BadRequestException, Controller, Get, Post, Query } from "@nestjs/common";
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

  /**
   * On-demand run. The scheduler already does this automatically.
   *
   * Deliberately fire-and-forget for the actual sync work (a full sync of a large
   * table can run for a long time — the HTTP call can't wait for that). But a run
   * that's already stuck from an earlier attempt used to fail this exact same way,
   * silently, forever: this endpoint always answered "started" even when nothing
   * was going to happen. Now the ONE thing that can be checked synchronously — is
   * this already running — is checked before answering, so that failure mode is
   * visible instead of indistinguishable from working.
   */
  @Post("sync/run")
  @Permissions("sync:run")
  run(@Query("full") full?: string, @Query("dataset") dataset?: string, @Query("truncate") truncate?: string) {
    const isFull = (full ?? "").toLowerCase() === "true";
    const isTruncate = (truncate ?? "").toLowerCase() === "true";
    if (isTruncate && !dataset) {
      throw new BadRequestException("Truncate & Sync must target one specific dataset");
    }
    if (dataset) {
      if (this.sync.runningKeys().includes(dataset)) {
        throw new BadRequestException(
          `Sync for '${dataset}' is already running. If it's been stuck for a long time, restart the backend to clear it.`,
        );
      }
      void this.sync.syncDataset(dataset, isFull, isTruncate).catch(() => undefined);
      return { status: "started", dataset, full: isFull || isTruncate, truncate: isTruncate };
    }
    const already = this.sync.runningKeys();
    if (already.length) {
      throw new BadRequestException(
        `Sync already running for: ${already.join(", ")}. If it's been stuck for a long time, restart the backend to clear it.`,
      );
    }
    void this.sync.syncAll(isFull).catch(() => undefined);
    return { status: "started", full: isFull };
  }

  /** Stop one dataset's in-progress sync — doesn't touch any other running sync. */
  @Post("sync/cancel")
  @Permissions("sync:run")
  cancel(@Query("dataset") dataset: string) {
    if (!dataset) throw new BadRequestException("dataset is required");
    const ok = this.sync.cancelSync(dataset);
    if (!ok) throw new BadRequestException(`'${dataset}' isn't currently running`);
    return { status: "cancelling", dataset };
  }
}
