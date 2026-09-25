import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import type { AiProvider } from '../config/env.validation.js';
import { ConversationEntity } from './entities/conversation.entity.js';
import { type AliceIdSource, UserEntity } from './entities/user.entity.js';

const UNIQUE_VIOLATION = '23505';

/**
 * Owns the Postgres side of a conversation: which Alice user we are talking to,
 * which provider answers them and which conversation is currently theirs.
 *
 * Message content is handled separately by {@link ConversationHistoryService},
 * and only for providers that cannot remember it themselves. This mapping is
 * what lets a conversation survive a backend or Redis restart.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async getOrCreateUser(aliceUserId: string, idSource: AliceIdSource): Promise<UserEntity> {
    const existing = await this.users.findOne({ where: { aliceUserId } });
    if (existing) {
      return existing;
    }

    try {
      return await this.users.save(this.users.create({ aliceUserId, idSource }));
    } catch (error) {
      // Two devices can open the skill at the same moment; the unique index wins
      // and we simply read the row the other request inserted.
      if (this.isUniqueViolation(error)) {
        const user = await this.users.findOne({ where: { aliceUserId } });
        if (user) {
          return user;
        }
      }
      throw error;
    }
  }

  getActiveConversation(userId: string): Promise<ConversationEntity | null> {
    return this.conversations.findOne({
      where: { userId, status: 'active' },
    });
  }

  /**
   * Archives whatever was active and stores the new session in one transaction,
   * so the "one active conversation per user" index is never violated.
   */
  async startConversation(
    userId: string,
    provider: AiProvider,
    providerSessionId: string,
  ): Promise<ConversationEntity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager
          .getRepository(ConversationEntity)
          .update({ userId, status: 'active' }, { status: 'archived' });

        const conversation = manager.getRepository(ConversationEntity).create({
          userId,
          provider,
          providerSessionId,
          status: 'active',
        });
        return manager.getRepository(ConversationEntity).save(conversation);
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      // Another request won the race for this user's active conversation.
      // Ours loses: the session we just created stays behind unused at the
      // provider,
      // which is far better than answering with an error. Normally the Redis
      // lock prevents this, so it only happens while Redis is unavailable.
      const existing = await this.getActiveConversation(userId);
      if (!existing) {
        throw error;
      }
      this.logger.warn(
        `Lost the race for the active conversation of user ${userId}; ` +
          `session ${providerSessionId} is left unused`,
      );
      return existing;
    }
  }

  async archiveConversation(conversationId: string): Promise<void> {
    await this.conversations.update({ id: conversationId }, { status: 'archived' });
  }

  /** Remembers the model picked by voice, so a stateless provider can reuse it. */
  async setModel(conversationId: string, model: string | null): Promise<void> {
    await this.conversations.update({ id: conversationId }, { model });
  }

  /** Bumps `updated_at` so the most recent conversation is easy to find. */
  async touch(conversationId: string): Promise<void> {
    try {
      await this.conversations.update({ id: conversationId }, { updatedAt: new Date() });
    } catch (error) {
      this.logger.warn(`Failed to touch conversation ${conversationId}: ${String(error)}`);
    }
  }

  countConversations(): Promise<number> {
    return this.conversations.count();
  }

  countUsers(): Promise<number> {
    return this.users.count();
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION
    );
  }
}
