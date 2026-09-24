import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration.js';
import { AdminApiKeyGuard } from './admin-api-key.guard.js';

const contextWith = (authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  }) as unknown as ExecutionContext;

const configWith = (apiKey?: string): ConfigService<AppConfig, true> =>
  ({ get: () => ({ apiKey }) }) as unknown as ConfigService<AppConfig, true>;

describe('AdminApiKeyGuard', () => {
  it('accepts the configured bearer token', () => {
    const guard = new AdminApiKeyGuard(configWith('secret-key'));
    expect(guard.canActivate(contextWith('Bearer secret-key'))).toBe(true);
  });

  it.each([
    ['a wrong key', 'Bearer wrong-key'],
    ['a missing header', undefined],
    ['a non-bearer header', 'Basic secret-key'],
    ['the key without the scheme', 'secret-key'],
  ])('rejects %s', (_case, header) => {
    const guard = new AdminApiKeyGuard(configWith('secret-key'));
    expect(() => guard.canActivate(contextWith(header))).toThrow(UnauthorizedException);
  });

  it('keeps the endpoint closed when no key is configured', () => {
    const guard = new AdminApiKeyGuard(configWith(undefined));
    expect(() => guard.canActivate(contextWith('Bearer anything'))).toThrow(UnauthorizedException);
  });
});
