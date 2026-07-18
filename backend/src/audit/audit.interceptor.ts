import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { catchError, tap } from "rxjs/operators";
import { AuthenticatedUser } from "../auth/jwt-payload.interface";
import { AuditService } from "./audit.service";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ACTION_BY_METHOD: Record<string, string> = {
  POST: "CREATE",
  PUT: "UPDATE",
  PATCH: "UPDATE",
  DELETE: "DELETE",
};

/** Logs every mutating request (and exports/logins) to audit_log. Never blocks the response. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const path: string = req.originalUrl ?? req.path ?? "";
    const method: string = req.method;
    const isExport = path.includes("/export");
    if (!MUTATING_METHODS.has(method) && !isExport) return next.handle();

    const user = req.user as AuthenticatedUser | undefined;
    const base = {
      userId: user?.id ?? null,
      userEmail: user?.email ?? req.body?.email ?? null,
      action: this.actionFor(method, path, isExport),
      entityType: this.entityTypeFor(path),
      entityId: req.params?.id ?? null,
      method,
      path,
      ipAddress: req.ip,
    };

    return next.handle().pipe(
      tap((body) => {
        void this.audit.record({
          ...base,
          afterState: this.sanitize(body),
          statusCode: context.switchToHttp().getResponse().statusCode,
        });
      }),
      catchError((err) => {
        void this.audit.record({ ...base, statusCode: err?.status ?? 500 });
        throw err;
      }),
    );
  }

  private actionFor(method: string, path: string, isExport: boolean): string {
    if (path.includes("/auth/login")) return "LOGIN";
    if (path.includes("/sync/run")) return "SYNC_RUN";
    if (isExport) return "EXPORT";
    return ACTION_BY_METHOD[method] ?? method;
  }

  private entityTypeFor(path: string): string {
    const segments = path.split("?")[0].split("/").filter(Boolean);
    const apiIdx = segments.indexOf("api");
    const rest = apiIdx >= 0 ? segments.slice(apiIdx + 1) : segments;
    return rest.find((s) => s !== "admin") ?? rest[0] ?? "unknown";
  }

  private sanitize(body: unknown): unknown {
    if (!body || typeof body !== "object") return null;
    const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    delete clone.password;
    delete clone.password_hash;
    delete clone.accessToken;
    delete clone.refreshToken;
    return clone;
  }
}
