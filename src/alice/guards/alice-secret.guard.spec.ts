import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration.js';
import { AliceSecretGuard } from './alice-secret.guard.js';

const contextWith = (secret?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ params: { secret } }) }),
  }) as unknown as ExecutionContext;

const config = {
  get: () => ({ webhookSecret: 'webhook-secret' }),
} as unknown as ConfigService<AppConfig, true>;

describe('AliceSecretGuard', () => {
  const guard = new AliceSecretGuard(config);

  it('accepts the configured secret', () => {
    expect(guard.canActivate(contextWith('webhook-secret'))).toBe(true);
  });

  it.each([
    ['a wrong secret', 'nope'],
    ['a missing secret', undefined],
    ['a prefix of the secret', 'webhook'],
    ['the secret with extra characters', 'webhook-secret-extra'],
  ])('rejects %s', (_case, secret) => {
    expect(() => guard.canActivate(contextWith(secret))).toThrow(ForbiddenException);
  });
});
