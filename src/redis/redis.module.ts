import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { REDIS_CLIENT, RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const client = RedisService.createClient(config);
        // ioredis emits 'error' on every reconnect attempt; without a listener
        // Node would treat it as an unhandled error event and crash the process.
        client.on('error', () => undefined);
        return client;
      },
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
