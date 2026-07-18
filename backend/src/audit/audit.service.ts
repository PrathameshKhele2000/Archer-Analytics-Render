import { Injectable, Logger } from "@nestjs/common";
import { AuditEntry, AuditRepository } from "./audit.repository";

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly repo: AuditRepository) {}

  /** Best-effort: an audit failure must never break the request it's logging. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.repo.record(entry);
    } catch (err: any) {
      this.log.error(`failed to write audit entry: ${err?.message ?? err}`);
    }
  }

  search(params: {
    userId?: number;
    action?: string;
    entityType?: string;
    from?: string;
    to?: string;
    page: number;
    size: number;
  }) {
    return this.repo.search(params);
  }
}
