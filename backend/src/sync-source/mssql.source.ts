import { BadRequestException, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as sql from "mssql";

export interface SourceColumn {
  name: string;
  sqlType: string;
  nullable: boolean;
}

/**
 * A two-part SQL Server name, e.g. dbo.ArcherFindingsFeed — or a single column name.
 * This function does double duty: parsing "schema.table" AND validating a bare
 * column name (describeTable/streamQuery call it on the watermark column too).
 * Real Archer exports routinely have spaces in column names ("CVE ID", "Content ID", "Last
 * Updated Date", ...), so the final segment allows anything except the characters
 * that would let it break out of our own "[...]" quoting or inject a newline — it
 * does NOT need to look like a programming identifier, only be safe to bracket-quote.
 * The optional schema prefix stays restricted to a plain identifier: nothing here
 * legitimately needs a space before the dot.
 */
const OBJECT_RE = /^(?:\[?([A-Za-z_][\w]{0,127})\]?\.)?\[?([^[\]\r\n]{1,128})\]?$/;

/** Split + validate a table/column name, then re-quote it ourselves — never interpolate raw input. */
export function parseObjectName(name: string): { schema: string; table: string; quoted: string } {
  const m = OBJECT_RE.exec((name ?? "").trim());
  if (!m) throw new BadRequestException(`Invalid source table name '${name}'`);
  const schema = m[1] ?? "dbo";
  const table = m[2].trim();
  if (!table) throw new BadRequestException(`Invalid source table name '${name}'`);
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
    const host = this.cfg.get<string>("mssql.host");
    const port = this.cfg.get<number>("mssql.port") ?? 1433;
    const database = this.cfg.get<string>("mssql.database");
    const instanceName = this.cfg.get<string>("mssql.instanceName");
    // A named instance ("HOST\INSTANCE") is resolved by the driver via the SQL
    // Browser service (UDP 1434) rather than a fixed port — passing both a port AND
    // an instanceName is invalid, so port is only sent when there's no instance name.
    const target = instanceName ? `${host}\\${instanceName}` : `${host}:${port}`;
    // Logged BEFORE connect() resolves: if this line never appears, the hang is
    // upstream of MS SQL entirely (config/DI); if it appears and nothing follows for
    // a long time, the hang is the connection handshake itself (network/firewall/
    // credentials) — otherwise this call would fail fast on its own connectionTimeout.
    this.log.log(`MS SQL connecting: ${target}/${database}…`);
    try {
      this.pool = await new sql.ConnectionPool({
        server: host!,
        ...(instanceName ? {} : { port }),
        database: database!,
        user: this.cfg.get<string>("mssql.user"),
        password: this.cfg.get<string>("mssql.password"),
        options: {
          encrypt: this.cfg.get<boolean>("mssql.encrypt") ?? false,
          trustServerCertificate: this.cfg.get<boolean>("mssql.trustServerCertificate") ?? true,
          ...(instanceName ? { instanceName } : {}),
        },
        pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
        // Generous, not infinite: a full sync of a large table over a slow link is
        // one long-running query now (streamed), so it must tolerate genuinely
        // taking a long time — but a real hang (a lock on the source, a stalled
        // connection that never fully drops) needs SOME ceiling, or the sync waits
        // forever with no automatic recovery, only a manual backend restart. 45
        // minutes comfortably covers a real 10M-row pull while still catching a
        // truly stuck query and turning it into a visible error instead of silence.
        // connectionTimeout (below) is separate and deliberately short: it's fine
        // for the initial handshake to fail fast if the server's unreachable at all.
        requestTimeout: 45 * 60_000,
        connectionTimeout: 15_000,
      }).connect();
    } catch (e: any) {
      // A raw driver error here (ECONNREFUSED, login failed, timeout, ...) used to
      // propagate uncaught and surface to the admin as a bare 500 — no message, no
      // way to tell "wrong host" apart from "wrong password" apart from "firewalled".
      // Wrapped as a BadRequestException, the actual driver message reaches the UI.
      throw new BadRequestException(
        `Could not connect to MS SQL at ${target}/${database} — ${e?.message ?? e}. ` +
        `Check MSSQL_HOST / MSSQL_INSTANCE / MSSQL_PORT / MSSQL_DATABASE / MSSQL_USER / MSSQL_PASSWORD in .env.`,
      );
    }
    this.log.log(`MS SQL connected: ${target}/${database}`);
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
   * Stream every matching row over ONE query instead of paging through many —
   * paging cost one network round trip per page (1000 rows each), which is fine on
   * a fast local link but becomes the dominant cost on a slow/high-latency one: 10M
   * rows at 1000/page is 10,000 round trips, each paying full network latency
   * before a single row moves. A single streamed query pays that latency once.
   * `since`/`watermarkColumn` still narrow it to an incremental change set when set.
   *
   * Rows arrive via the returned `request`'s 'row' event as they're read off the
   * wire — the caller is responsible for backpressure (request.pause()/resume())
   * against whatever it's writing them into, and for listening for 'error'. `done`
   * resolves once the whole result set has been delivered.
   */
  async streamQuery(opts: {
    table: string;
    watermarkColumn?: string | null;
    since?: Date | null;
  }): Promise<{ request: sql.Request; done: Promise<void> }> {
    const { quoted } = parseObjectName(opts.table);
    const wm = opts.watermarkColumn ? parseObjectName(opts.watermarkColumn).table : null;

    const pool = await this.getPool();
    const request = pool.request();
    request.stream = true;
    let where = "";
    if (wm && opts.since) {
      request.input("since", sql.DateTime2, opts.since);
      where = `WHERE [${wm}] > @since`;
    }
    const done = new Promise<void>((resolve, reject) => {
      request.on("error", (err: any) => reject(err));
      request.on("done", () => resolve());
    });
    request.query(`SELECT * FROM ${quoted} ${where}`); // streaming: don't await, consume via events
    return { request, done };
  }
}
