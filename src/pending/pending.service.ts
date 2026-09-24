import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config/configuration.js';
import { RedisService } from '../redis/redis.service.js';

export type ModelProfile = 'fast' | 'smart';

/** Lightweight marker that a turn is still running on OpenAI's side. */
export interface PendingTurn {
  conversationId: string;
  openaiSessionId: string;
  turnId: string | null;
  startedAt: string;
}

/**
 * Holds the short-lived per-user state in Redis: the lock that keeps one turn
 * per user and the marker describing a turn we stopped waiting for.
 *
 * Deliberately *not* a source of truth — the answer itself stays in the OpenAI
 * session and the session id lives in Postgres, so losing Redis costs comfort,
 * not data.
 */
@Injectable()
export class PendingService {
  private static readonly LOCK_TTL_MS = 30_000;
  private static readonly MODEL_TTL_SECONDS = 30 * 24 * 60 * 60;

  private readonly logger = new Logger(PendingService.name);
  private readonly pendingTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.pendingTtlSeconds = config.get('redis', { infer: true }).pendingStateTtlSeconds;
  }

  /** Returns a lock token, or null when another request for this user holds it. */
  async acquireTurnLock(userKey: string): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.acquireLock(
      this.lockKey(userKey),
      token,
      PendingService.LOCK_TTL_MS,
    );
    return acquired ? token : null;
  }

  async releaseTurnLock(userKey: string, token: string): Promise<void> {
    await this.redis.releaseLock(this.lockKey(userKey), token);
  }

  async setPending(userKey: string, pending: PendingTurn): Promise<void> {
    await this.redis.setEx(
      this.pendingKey(userKey),
      JSON.stringify(pending),
      this.pendingTtlSeconds,
    );
  }

  async getPending(userKey: string): Promise<PendingTurn | null> {
    const raw = await this.redis.get(this.pendingKey(userKey));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PendingTurn;
    } catch {
      this.logger.warn(`Dropping malformed pending state for ${userKey}`);
      await this.clearPending(userKey);
      return null;
    }
  }

  async clearPending(userKey: string): Promise<void> {
    await this.redis.del(this.pendingKey(userKey));
  }

  async setModelProfile(userKey: string, profile: ModelProfile): Promise<void> {
    await this.redis.setEx(this.modelKey(userKey), profile, PendingService.MODEL_TTL_SECONDS);
  }

  async getModelProfile(userKey: string): Promise<ModelProfile | null> {
    const value = await this.redis.get(this.modelKey(userKey));
    return value === 'fast' || value === 'smart' ? value : null;
  }

  countPendingTurns(): Promise<number> {
    return this.redis.countKeys('alice:user:*:pending');
  }

  private pendingKey(userKey: string): string {
    return `alice:user:${userKey}:pending`;
  }

  private lockKey(userKey: string): string {
    return `alice:user:${userKey}:generation-lock`;
  }

  private modelKey(userKey: string): string {
    return `alice:user:${userKey}:model`;
  }
}
