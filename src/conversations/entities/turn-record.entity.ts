import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { ConversationEntity } from './conversation.entity.js';

/** Local view of an Agent turn's lifecycle; `running` covers queued/in_progress/waiting. */
export type TurnRecordStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Usage/audit metadata for one Agent turn — deliberately no message content:
 * the conversation itself lives in the OpenAI session and must not be duplicated.
 */
@Entity('turn_records')
@Index('idx_turn_records_conversation_created_at', ['conversationId', 'createdAt'])
@Index('idx_turn_records_created_at', ['createdAt'])
export class TurnRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation!: ConversationEntity;

  /** Null while the turn id is still unknown (input accepted but no turn event seen yet). */
  @Index('uq_turn_records_openai_turn_id', { unique: true })
  @Column({ name: 'openai_turn_id', type: 'text', nullable: true })
  openaiTurnId!: string | null;

  @Column({ name: 'status', type: 'text' })
  status!: TurnRecordStatus;

  @Column({ name: 'model', type: 'text', nullable: true })
  model!: string | null;

  @Column({ name: 'input_tokens', type: 'int', nullable: true })
  inputTokens!: number | null;

  @Column({ name: 'output_tokens', type: 'int', nullable: true })
  outputTokens!: number | null;

  @Column({ name: 'reasoning_tokens', type: 'int', nullable: true })
  reasoningTokens!: number | null;

  @Column({ name: 'cached_tokens', type: 'int', nullable: true })
  cachedTokens!: number | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs!: number | null;

  @Column({ name: 'deferred', type: 'boolean', default: false })
  deferred!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
