import { BadRequestException, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as sql from "mssql";

export interface SourceColumn {
  name: string;
  sqlType: string;
  nullable: boolean;
}

/** A two-part SQL Server name, e.g. dbo.ArcherFindingsFeed. */
const OBJECT_RE = /^(?:\[?([A-Za-z_][\w]{0,127})\]?\.)?\[?([A-Za-z_][\w]{0,127})\]?$/;

/** Split + validate a table name, then re-quote it ourselves — never interpolate raw input. */
export function parseObjectName(name: string): { schema: string; table: string; quoted: string } {
  const m = OBJECT_RE.exec((name ?? "").trim());
  if (!m) throw new BadRequestException(`Invalid source table name '${name}'`);
  const schema = m[1] ?? "dbo";
  const table = m[2];
  return { schema, table, quoted: `[${schema}].[${table}]` };
}

/**
 * Read-only reader for the flat Archer reporting feed in MS SQL.
 *
 * This class only ever issues SELECTs — there is no insert/update/delete path —
 * and the account it uses should be db_datareader, so Archer's side cannot be
 * modified even by accident.
 */
@Injectable()
export class MssqlSource implements OnModuleDestroy {
  private readonly log = new Logger(MssqlSource.name);
  private pool: sql.ConnectionPool | null = null;

  constructor(private readonly cfg: ConfigService) {}

  isConfigured(): boolean {
    return !!this.cfg.get<string>("mssql.host") && !!this.cfg.get<string>("mssql.database");
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    if (!this.isConfigured()) {
      throw new BadRequestException(
        "MS SQL reporting source is not configured — set MSSQL_HOST / MSSQL_DATABASE / MSSQL_USER / MSSQL_PASSWORD",
      );
    }
    this.pool = await new sql.ConnectionPool({
      server: this.cfg.get<string>("mssql.host")!,
      port: this.cfg.get<number>("mssql.port") ?? 1433,
      database: this.cfg.get<string>("mssql.database")!,
      user: this.cfg.get<string>("mssql.user"),
      password: this.cfg.get<string>("mssql.password"),
      options: {
        encrypt: this.cfg.get<boolean>("mssql.encrypt") ?? false,
        trustServerCertificate: this.cfg.get<boolean>("mssql.trustServerCertificate") ?? true,
      },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
      requestTimeout: 120_000,
    }).connect();
    this.log.log(`MS SQL connected: ${this.cfg.get("mssql.host")}/${this.cfg.get("mssql.database")}`);
    return this.pool;
  }

  async onModuleDestroy() {
    await this.pool?.close().catch(() => undefined);
  }

  /** Connectivity check for the admin screen. */
  async ping(): Promise<{ ok: boolean; server?: string; error?: string }> {
    try {
      const pool = await this.getPool();
      const r = await pool.request().query("SELECT @@VERSION AS v");
      return { ok: true, server: String(r.recordset[0]?.v ?? "").split("\n")[0] };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /** The tables/views available to read — this is what "pick a source table" offers. */
  async listTables(): Promise<{ name: string; type: string }[]> {
    const pool = await this.getPool();
    const r = await pool.request().query(
      `SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name, TABLE_TYPE AS type
       FROM INFORMATION_SCHEMA.TABLES
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return r.recordset.map((x: any) => ({ name: x.name, type: x.type }));
  }

  /** The real column names + types — this is what removes all datatype guesswork. */
  async describeTable(tableName: string): Promise<SourceColumn[]> {
    const { schema, table } = parseObjectName(tableName);
    const pool = await this.getPool();
    const r = await pool
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS sqlType, IS_NULLABLE AS nullable
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
         ORDER BY ORDINAL_POSITION`,
      );
    if (!r.recordset.length) throw new BadRequestException(`Source table '${tableName}' not found or not readable`);
    return r.recordset.map((c: any) => ({
      name: c.name, sqlType: String(c.sqlType), nullable: c.nullable === "YES",
    }));
  }

  /**
   * One page of rows, oldest-change-first. `since` makes it incremental: only rows
   * whose watermark moved. Keyset-free paging (OFFSET/FETCH) is fine here because
   * we order by the watermark and page through a bounded change set.
   */
  async readBatch(opts: {
    table: string;
    keyColumn: string;
    watermarkColumn?: string | null;
    since?: Date | null;
    offset: number;
    limit: number;
  }): Promise<any[]> {
    const { quoted } = parseObjectName(opts.table);
    const key = parseObjectName(opts.keyColumn).table; // validates the identifier
    const wm = opts.watermarkColumn ? parseObjectName(opts.watermarkColumn).table : null;

    const pool = await this.getPool();
    const req = pool.request();
    let where = "";
    if (wm && opts.since) {
      req.input("since", sql.DateTime2, opts.since);
      where = `WHERE [${wm}] > @since`;
    }
    const orderBy = wm ? `[${wm}] ASC, [${key}] ASC` : `[${key}] ASC`;
    const r = await req.query(
      `SELECT * FROM ${quoted} ${where}
       ORDER BY ${orderBy}
       OFFSET ${Math.max(0, Math.floor(opts.offset))} ROWS
       FETCH NEXT ${Math.max(1, Math.floor(opts.limit))} ROWS ONLY`,
    );
    return r.recordset;
  }
}
