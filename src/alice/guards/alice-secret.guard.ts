import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import type { AppConfig } from '../../config/configuration.js';

/**
 * Yandex Dialogs does not sign its webhooks, so the shared secret in the URL
 * path is what keeps random internet traffic out. Compared in constant time so
 * the endpoint does not leak the secret through response timing.
 */
@Injectable()
export class AliceSecretGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService<AppConfig, true>) {
    this.expected = Buffer.from(config.get('alice', { infer: true }).webhookSecret, 'utf8');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest<{ Params: { secret?: string } }>>();
    const provided = Buffer.from(request.params?.secret ?? '', 'utf8');

    if (provided.length !== this.expected.length || !timingSafeEqual(provided, this.expected)) {
      throw new ForbiddenException('Invalid webhook secret');
    }

    return true;
  }
}
