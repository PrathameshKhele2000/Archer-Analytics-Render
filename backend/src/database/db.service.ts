import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, PoolClient, QueryResultRow, types } from "pg";

// pg returns int8/numeric as strings; the dashboard needs real numbers.
types.setTypeParser(20, (v) => parseInt(v, 10)); // int8 (count(*))
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
// Keep DATE as plain YYYY-MM-DD string (matches the frontend contract).
types.setTypeParser(1082, (v) => v);

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DbService.name);
  pool: Pool;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.pool = new Pool({
      connectionString: this.config.get<string>("databaseUrl"),
      max: parseInt(process.env.DB_POOL_MAX ?? "20", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on("error", (err) => this.log.error(`pg pool error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
    return this.pool.query(text, params);
  }

  connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /** Unit-of-work helper: runs `fn` inside BEGIN/COMMIT, ROLLBACK on throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
