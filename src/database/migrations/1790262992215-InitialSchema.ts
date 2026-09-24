import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1790262992215 implements MigrationInterface {
  name = 'InitialSchema1790262992215';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // uuid_generate_v4() is what TypeORM emits for @PrimaryGeneratedColumn('uuid').
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "alice_user_id" text NOT NULL, "id_source" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_users_alice_user_id" ON "users"  ("alice_user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "conversations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "openai_session_id" text NOT NULL, "status" text NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_conversations_openai_session_id" ON "conversations"  ("openai_session_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_conversations_active_per_user" ON "conversations"  ("user_id") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_conversations_user_updated_at" ON "conversations"  ("user_id", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "turn_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "conversation_id" uuid NOT NULL, "openai_turn_id" text, "status" text NOT NULL, "model" text, "input_tokens" integer, "output_tokens" integer, "reasoning_tokens" integer, "cached_tokens" integer, "latency_ms" integer, "deferred" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_419ee40cb8017643bd9721186c3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_turn_records_openai_turn_id" ON "turn_records"  ("openai_turn_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_records_created_at" ON "turn_records"  ("created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_records_conversation_created_at" ON "turn_records"  ("conversation_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_3a9ae579e61e81cc0e989afeb4a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "turn_records" ADD CONSTRAINT "FK_c76745a7d78c2463d5f412372df" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "turn_records" DROP CONSTRAINT "FK_c76745a7d78c2463d5f412372df"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_3a9ae579e61e81cc0e989afeb4a"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_turn_records_conversation_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_turn_records_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."uq_turn_records_openai_turn_id"`);
    await queryRunner.query(`DROP TABLE "turn_records"`);
    await queryRunner.query(`DROP INDEX "public"."idx_conversations_user_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."uq_conversations_active_per_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_conversations_openai_session_id"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
    await queryRunner.query(`DROP INDEX "public"."uq_users_alice_user_id"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
