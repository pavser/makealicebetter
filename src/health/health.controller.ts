import { Controller, Get, HttpCode, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RedisService } from '../redis/redis.service.js';

interface ReadinessReport {
  status: 'ok' | 'degraded';
  postgres: boolean;
  redis: boolean;
}

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Get('health')
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness: can we actually serve a request? Checks Postgres and Redis only —
   * OpenAI is deliberately not called, a health probe must not cost money.
   */
  @Get('ready')
  @HttpCode(200)
  async ready(): Promise<ReadinessReport> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.redis.ping()]);
    return {
      status: postgres && redis ? 'ok' : 'degraded',
      postgres,
      redis,
    };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.warn(`Postgres readiness check failed: ${String(error)}`);
      return false;
    }
  }
}
