import { QueryResultRow } from "pg";
import { DbService } from "../database/db.service";

/**
 * Thin repository base: centralizes table access so services never issue
 * raw SQL directly. Subclasses add domain-specific query methods.
 */
export abstract class BaseRepository<T extends QueryResultRow = any> {
  protected abstract readonly table: string;

  constructor(protected readonly db: DbService) {}

  protected query<R extends QueryResultRow = T>(sql: string, params: any[] = []) {
    return this.db.query<R>(sql, params);
  }

  async findById(id: number | string, idColumn = "id"): Promise<T | null> {
    const { rows } = await this.query(`SELECT * FROM ${this.table} WHERE ${idColumn} = $1`, [id]);
    return rows[0] ?? null;
  }

  async findAll(orderBy?: string): Promise<T[]> {
    const { rows } = await this.query(`SELECT * FROM ${this.table}${orderBy ? ` ORDER BY ${orderBy}` : ""}`);
    return rows;
  }

  async deleteById(id: number | string, idColumn = "id"): Promise<void> {
    await this.query(`DELETE FROM ${this.table} WHERE ${idColumn} = $1`, [id]);
  }

  /** Unit-of-work: run multiple statements atomically. */
  transaction<R>(fn: Parameters<DbService["transaction"]>[0]): Promise<R> {
    return this.db.transaction(fn) as Promise<R>;
  }
}
