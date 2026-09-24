import 'reflect-metadata';

import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from './data-source-options.js';

// TypeORM 1.x dropped built-in .env support, so the CLI loads it explicitly.
loadEnv();

/** Data source used by the TypeORM CLI (`npm run migration:*`). */
export default new DataSource(
  buildDataSourceOptions({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'alice',
    password: process.env.POSTGRES_PASSWORD ?? 'alice',
    database: process.env.POSTGRES_DB ?? 'alice',
  }),
);
