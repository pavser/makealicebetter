import { join } from 'node:path';

import type { DataSourceOptions } from 'typeorm';

import { ConversationEntity } from '../conversations/entities/conversation.entity.js';
import { MessageEntity } from '../conversations/entities/message.entity.js';
import { TurnRecordEntity } from '../conversations/entities/turn-record.entity.js';
import { UserEntity } from '../conversations/entities/user.entity.js';

export interface PostgresConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Single source of truth for the TypeORM configuration, shared by the Nest
 * module and the CLI data source so migrations always match the running app.
 *
 * `synchronize` is never enabled — schema changes go through migrations only.
 */
export function buildDataSourceOptions(connection: PostgresConnection): DataSourceOptions {
  return {
    type: 'postgres',
    host: connection.host,
    port: connection.port,
    username: connection.user,
    password: connection.password,
    database: connection.database,
    entities: [UserEntity, ConversationEntity, TurnRecordEntity, MessageEntity],
    // `import.meta.dirname` because the project is ESM (NestJS 12 ships ESM-only).
    migrations: [join(import.meta.dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'migrations',
    synchronize: false,
    logging: ['error', 'warn', 'migration'],
  };
}
