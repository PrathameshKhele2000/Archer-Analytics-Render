import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private ttl: number;
  /** Set once Redis proves unreachable: every later call becomes an instant no-op. */
  private disabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.ttl = this.config.get<number>("cacheTtlSeconds")!;
    const url = (this.config.get<string>("redisUrl") ?? "").trim();

    // No cache configured (common on hosted setups without a Redis instance):
    // stay disabled rather than retrying a host that will never resolve — otherwise
    // every cached read pays connection-retry latency on each request.
    if (!url) {
      this.disabled = true;
      this.log.log("REDIS_URL not set — cache disabled (the API works without it)");
      return;
    }

    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      // Fail commands immediately while disconnected instead of queueing them.
      enableOfflineQueue: false,
      // Give up reconnecting after a few tries; the app is fully functional without cache.
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    this.redis.on("error", (e) => {
      if (!this.disabled) this.log.warn(`redis: ${e.message} — cache degraded`);
    });
    this.redis.on("end", () => {
      if (!this.disabled) {
        this.disabled = true;
        this.log.warn("redis unreachable — cache disabled for this process");
      }
    });
  }

  async onModuleDestroy() {
    this.disabled = true;
    await this.redis?.quit().catch(() => undefined);
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (this.disabled || !this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null; // cache outage must never break (or slow) the API
    }
  }

  async setJson(key: string, value: unknown, ttl?: number): Promise<void> {
    if (this.disabled || !this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttl ?? this.ttl);
    } catch {
      /* best effort */
    }
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    if (this.disabled || !this.redis) return;
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
