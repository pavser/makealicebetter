import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { RedisService } from '../redis/redis.service.js';
import { PendingService } from './pending.service.js';

describe('PendingService', () => {
  const config = {
    get: () => ({ pendingStateTtlSeconds: 600 }),
  } as unknown as ConfigService<AppConfig, true>;

  let redis: jest.Mocked<RedisService>;
  let pending: PendingService;

  beforeEach(() => {
    redis = {
      get: jest.fn(async () => null),
      setEx: jest.fn(async () => true),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
      countKeys: jest.fn(async () => 0),
      ping: jest.fn(async () => true),
    } as unknown as jest.Mocked<RedisService>;

    pending = new PendingService(redis, config);
  });

  describe('generation lock', () => {
    it('returns a token when the lock is free', async () => {
      const token = await pending.acquireTurnLock('user-key');

      expect(token).toEqual(expect.any(String));
      expect(redis.acquireLock).toHaveBeenCalledWith(
        'alice:user:user-key:generation-lock',
        token,
        30_000,
      );
    });

    it('returns null when another request holds the lock', async () => {
      redis.acquireLock.mockResolvedValue(false);
      await expect(pending.acquireTurnLock('user-key')).resolves.toBeNull();
    });

    it('releases with the same token so it cannot free someone else’s lock', async () => {
      await pending.releaseTurnLock('user-key', 'token-1');
      expect(redis.releaseLock).toHaveBeenCalledWith(
        'alice:user:user-key:generation-lock',
        'token-1',
      );
    });
  });

  describe('pending state', () => {
    const state = {
      conversationId: 'conv-1',
      providerSessionId: 'sess-1',
      turnId: 'turn-1',
      startedAt: '2026-09-24T10:00:00.000Z',
    };

    it('stores the marker with a TTL — temporary keys never leak', async () => {
      await pending.setPending('user-key', state);

      expect(redis.setEx).toHaveBeenCalledWith(
        'alice:user:user-key:pending',
        JSON.stringify(state),
        600,
      );
    });

    it('reads the marker back', async () => {
      redis.get.mockResolvedValue(JSON.stringify(state));
      await expect(pending.getPending('user-key')).resolves.toEqual(state);
    });

    it('drops malformed state instead of throwing', async () => {
      redis.get.mockResolvedValue('{not json');

      await expect(pending.getPending('user-key')).resolves.toBeNull();
      expect(redis.del).toHaveBeenCalledWith('alice:user:user-key:pending');
    });

    it('treats a Redis outage as "nothing pending"', async () => {
      redis.get.mockResolvedValue(null);
      await expect(pending.getPending('user-key')).resolves.toBeNull();
    });
  });

  describe('model profile', () => {
    it('stores the profile with a long but finite TTL', async () => {
      await pending.setModelProfile('user-key', 'smart');
      expect(redis.setEx).toHaveBeenCalledWith('alice:user:user-key:model', 'smart', 2_592_000);
    });

    it('ignores unexpected values', async () => {
      redis.get.mockResolvedValue('turbo');
      await expect(pending.getModelProfile('user-key')).resolves.toBeNull();
    });
  });
});
