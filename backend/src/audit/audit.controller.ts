import { Controller, Get, Query } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { AuditService } from "./audit.service";

@Controller("api/audit")
@Permissions("audit:read")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  search(
    @Query("userId") userId?: string,
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") pageQ?: string,
    @Query("size") sizeQ?: string,
  ) {
    const page = Math.max(1, parseInt(pageQ ?? "1", 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(sizeQ ?? "50", 10) || 50));
    return this.audit.search({
      userId: userId ? parseInt(userId, 10) : undefined,
      action,
      entityType,
      from,
      to,
      page,
      size,
    });
  }
}
