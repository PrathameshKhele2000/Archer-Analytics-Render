import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CacheService.name);
  private redis: Redis;
  private ttl: number;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.redis = new Redis(this.config.get<string>("redisUrl")!, {
      maxRetriesPerRequest: 2,
    });
    this.redis.on("error", (e) => this.log.warn(`redis: ${e.message}`));
    this.ttl = this.config.get<number>("cacheTtlSeconds")!;
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null; // cache outage must never break the API
    }
  }

  async setJson(key: string, value: unknown, ttl?: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttl ?? this.ttl);
    } catch {
      /* best effort */
    }
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    try {
      const stream = this.redis.scanStream({ match: `${prefix}*`, count: 100 });
      for await (const keys of stream) {
        if ((keys as string[]).length) await this.redis.del(...(keys as string[]));
      }
    } catch {
      /* best effort */
    }
  }
}
