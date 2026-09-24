import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import type { AppConfig } from './config/configuration.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // Yandex keeps adding optional fields to the protocol: unknown properties
      // must pass through instead of failing the webhook.
      whitelist: false,
      forbidNonWhitelisted: false,
      validateCustomDecorators: true,
    }),
  );

  // Closes the HTTP server, TypeORM pool and Redis connection on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });

  await app.listen({ port, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`Listening on port ${port}`);
}

void bootstrap();
