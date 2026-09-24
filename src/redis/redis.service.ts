import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { AppConfig } from '../config/configuration.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Thin wrapper over ioredis.
 *
 * Every method is fail-open: when Redis is down the caller gets `null`/`false`
 * instead of an exception, because a missing lock or pending marker must never
 * stop Alice from getting an answer. Commands are configured to fail fast
 * (no offline queue, short command timeout) so a dead Redis cannot eat into the
 * 4.5s Yandex Dialogs budget.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  static createClient(config: ConfigService<AppConfig, true>): Redis {
    const redis = config.get('redis', { infer: true });
    return new Redis({
      host: redis.host,
      port: redis.port,
      password: redis.password,
      db: redis.db,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      retryStrategy: (times: number) => Math.min(times * 200, 5_000),
      lazyConnect: false,
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      this.logFailure('GET', key, error);
      return null;
    }
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return true;
    } catch (error) {
      this.logFailure('SETEX', key, error);
      return false;
    }
  }

  /** `SET key value NX PX ttl` — returns false when the key already exists or Redis is down. */
  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logFailure('SET NX', key, error);
      // Fail open: without Redis we cannot serialise turns, but we still answer.
      return true;
    }
  }

  /** Releases a lock only when it is still ours, so a slow request cannot free someone else's lock. */
  async releaseLock(key: string, token: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    try {
      await this.client.eval(script, 1, key, token);
    } catch (error) {
      this.logFailure('EVAL release', key, error);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logFailure('DEL', key, error);
    }
  }

  async countKeys(pattern: string): Promise<number> {
    try {
      let cursor = '0';
      let total = 0;
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        total += keys.length;
      } while (cursor !== '0');
      return total;
    } catch (error) {
      this.logFailure('SCAN', pattern, error);
      return 0;
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private logFailure(command: string, key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Redis ${command} failed for "${key}": ${message}`);
  }
}
