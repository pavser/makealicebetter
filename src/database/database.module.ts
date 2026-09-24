import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import type { AppConfig } from '../config/configuration.js';
import { buildDataSourceOptions } from './data-source-options.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        ...buildDataSourceOptions(config.get('postgres', { infer: true })),
        // Keep startup resilient: a temporarily unreachable database must not
        // prevent the process from booting and serving /health.
        retryAttempts: 3,
        retryDelay: 2_000,
        autoLoadEntities: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
