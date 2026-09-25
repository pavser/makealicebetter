import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { AiProvider } from '../../config/env.validation.js';
import { UserEntity } from './user.entity.js';

export type ConversationStatus = 'active' | 'archived';

/**
 * Maps one Alice conversation to one conversation on the provider's side.
 *
 * `provider` is what makes the mapping trustworthy: a session id means nothing
 * without knowing who issued it, and switching providers must archive the old
 * conversation rather than hand a foreign id to an API that will reject it.
 *
 * Whether the message history lives here or at the provider depends on the
 * provider — see {@link MessageEntity}.
 *
 * Relations are declared one-way (no inverse `@OneToMany`): nothing reads them,
 * and in an ESM build mutual entity imports create a circular-import failure.
 */
@Entity('conversations')
@Index('idx_conversations_user_updated_at', ['userId', 'updatedAt'])
// A user can only ever have one active conversation; enforced by the database
// rather than by application logic so concurrent requests cannot break it.
@Index('uq_conversations_active_per_user', ['userId'], {
  unique: true,
  where: `status = 'active'`,
})
export class ConversationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  /** Which backend issued {@link providerSessionId} and owns this conversation. */
  @Column({ name: 'provider', type: 'text' })
  provider!: AiProvider;

  @Index('uq_conversations_provider_session_id', { unique: true })
  @Column({ name: 'provider_session_id', type: 'text' })
  providerSessionId!: string;

  /**
   * Model chosen by voice for this conversation, or null for the provider's
   * default. Stored here rather than in memory because a stateless provider
   * picks the model on every request and must survive a restart.
   */
  @Column({ name: 'model', type: 'text', nullable: true })
  model!: string | null;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status!: ConversationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
