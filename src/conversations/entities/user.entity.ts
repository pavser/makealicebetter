import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Which Alice identifier the user row is keyed by.
 *
 * `user` is the stable Yandex account id (same across devices) and is preferred;
 * `application` is the per-installation id used when the speaker is not signed in.
 */
export type AliceIdSource = 'user' | 'application';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_users_alice_user_id', { unique: true })
  @Column({ name: 'alice_user_id', type: 'text' })
  aliceUserId!: string;

  @Column({ name: 'id_source', type: 'text' })
  idSource!: AliceIdSource;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
