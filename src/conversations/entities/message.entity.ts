import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { TurnUsage } from '../../ai/types/ai.types.js';
import { ConversationEntity } from './conversation.entity.js';

export type MessageRole = 'user' | 'assistant';

/**
 * One message of a conversation whose provider does not remember it.
 *
 * Only stateless providers write here — Anthropic's Messages API keeps no
 * history and offers no way to fetch a finished answer later, so this table
 * has to serve both purposes at once:
 *
 *  - **history**: the messages resent on the next question;
 *  - **deferred answers**: an answer that arrived after Alice stopped waiting
 *    is stored as an assistant row and picked up by its `providerTurnId`.
 *
 * OpenAI conversations leave no rows here at all — duplicating what already
 * lives on their side would only create a second source of truth.
 */
@Entity('messages')
@Index('idx_messages_conversation_created_at', ['conversationId', 'createdAt'])
@Index('uq_messages_provider_turn_id', ['providerTurnId'], {
  unique: true,
  where: 'provider_turn_id IS NOT NULL',
})
export class MessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation!: ConversationEntity;

  @Column({ name: 'role', type: 'text' })
  role!: MessageRole;

  @Column({ name: 'content', type: 'text' })
  content!: string;

  /** Set on assistant rows: the id this answer is fetched by after a deferral. */
  @Column({ name: 'provider_turn_id', type: 'text', nullable: true })
  providerTurnId!: string | null;

  @Column({ name: 'model', type: 'text', nullable: true })
  model!: string | null;

  /**
   * Kept alongside the answer so a deferred pickup still records token counts —
   * by then the stream that reported them is long gone.
   */
  @Column({ name: 'usage', type: 'jsonb', nullable: true })
  usage!: TurnUsage | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
