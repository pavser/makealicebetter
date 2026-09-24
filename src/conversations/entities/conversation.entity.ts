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

import { UserEntity } from './user.entity.js';

export type ConversationStatus = 'active' | 'archived';

/**
 * Maps one Alice conversation to one durable OpenAI Agent Session.
 *
 * The session itself holds the message history, so nothing about the dialogue
 * content is stored here — only the mapping needed to resume it after a restart.
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

  @Index('uq_conversations_openai_session_id', { unique: true })
  @Column({ name: 'openai_session_id', type: 'text' })
  openaiSessionId!: string;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status!: ConversationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
