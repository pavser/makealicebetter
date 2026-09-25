import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { TurnUsage } from '../ai/types/ai.types.js';
import { ConversationEntity } from './entities/conversation.entity.js';
import { MessageEntity, type MessageRole } from './entities/message.entity.js';

/** One exchange as a stateless provider needs it back. */
export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

export interface StoredAnswer {
  text: string;
  model: string | null;
  usage: TurnUsage | null;
}

/**
 * Message storage for providers that have none of their own.
 *
 * Anthropic's Messages API forgets everything between calls and cannot return a
 * finished answer afterwards, so this service is both the conversation's memory
 * and the drop box for answers that arrived after Alice stopped listening.
 *
 * Providers address conversations by their own session id, so every method
 * takes that rather than the local row id.
 */
@Injectable()
export class ConversationHistoryService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
  ) {}

  /**
   * The tail of the conversation, oldest first.
   *
   * Trimming happens here rather than in the provider because the cost is paid
   * per request: every message resent is billed and waited on again.
   */
  async recentMessages(providerSessionId: string, limit: number): Promise<HistoryMessage[]> {
    const conversationId = await this.resolveConversationId(providerSessionId);
    if (!conversationId) {
      return [];
    }

    const rows = await this.messages.find({
      where: { conversationId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      select: { role: true, content: true },
    });

    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  }

  async appendUserMessage(providerSessionId: string, content: string): Promise<void> {
    const conversationId = await this.resolveConversationId(providerSessionId);
    if (!conversationId) {
      return;
    }

    await this.messages.insert({ conversationId, role: 'user', content, providerTurnId: null });
  }

  /**
   * Stores a finished answer. Ignores a repeat of the same turn: the background
   * read and a follow-up lookup can both land here.
   */
  async appendAssistantMessage(
    providerSessionId: string,
    turnId: string,
    answer: StoredAnswer,
  ): Promise<void> {
    const conversationId = await this.resolveConversationId(providerSessionId);
    if (!conversationId) {
      return;
    }

    await this.messages
      .createQueryBuilder()
      .insert()
      .values({
        conversationId,
        role: 'assistant',
        content: answer.text,
        providerTurnId: turnId,
        model: answer.model,
        usage: answer.usage,
      })
      .orIgnore()
      .execute();
  }

  /**
   * The model picked by voice for this conversation, or null for the default.
   * A stateless provider chooses a model per request and has nowhere else to
   * remember the choice.
   */
  async findConversationModel(providerSessionId: string): Promise<string | null> {
    const conversation = await this.conversations.findOne({
      where: { providerSessionId },
      select: { model: true },
    });
    return conversation?.model ?? null;
  }

  /** Reads back a stored answer by the turn id Alice was told to come back for. */
  async findAnswer(turnId: string): Promise<StoredAnswer | null> {
    const row = await this.messages.findOne({
      where: { providerTurnId: turnId },
      select: { content: true, model: true, usage: true },
    });

    return row ? { text: row.content, model: row.model, usage: row.usage } : null;
  }

  private async resolveConversationId(providerSessionId: string): Promise<string | null> {
    const conversation = await this.conversations.findOne({
      where: { providerSessionId },
      select: { id: true },
    });
    return conversation?.id ?? null;
  }
}
