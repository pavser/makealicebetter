import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import type { AppConfig } from '../../config/configuration.js';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly expected?: Buffer;

  constructor(config: ConfigService<AppConfig, true>) {
    const key = config.get('admin', { infer: true }).apiKey;
    this.expected = key ? Buffer.from(key, 'utf8') : undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) {
      // No key configured means the admin API stays closed.
      throw new UnauthorizedException();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = Buffer.from(token, 'utf8');

    if (provided.length !== this.expected.length || !timingSafeEqual(provided, this.expected)) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
