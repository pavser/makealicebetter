import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the schema provider-aware and gives stateless providers somewhere to
 * keep a conversation.
 *
 * Columns are renamed rather than dropped and recreated: production already
 * holds live conversations, and a DROP would silently orphan every one of them.
 * Existing rows predate Claude, so they are backfilled as 'responses' — the
 * provider that actually produced them.
 */
export class ProviderSystem1790400000000 implements MigrationInterface {
  name = 'ProviderSystem1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- conversations: who owns this conversation, and on which model
    await queryRunner.query(
      `ALTER TABLE "conversations" RENAME COLUMN "openai_session_id" TO "provider_session_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "uq_conversations_openai_session_id" RENAME TO "uq_conversations_provider_session_id"`,
    );
    await queryRunner.query(`ALTER TABLE "conversations" ADD "provider" text`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD "model" text`);
    // Everything stored so far came from the Responses path.
    await queryRunner.query(`UPDATE "conversations" SET "provider" = 'responses'`);
    await queryRunner.query(`ALTER TABLE "conversations" ALTER COLUMN "provider" SET NOT NULL`);

    // --- turn_records: the same, plus a provider-scoped idempotency key
    await queryRunner.query(
      `ALTER TABLE "turn_records" RENAME COLUMN "openai_turn_id" TO "provider_turn_id"`,
    );
    await queryRunner.query(`ALTER TABLE "turn_records" ADD "provider" text`);
    await queryRunner.query(`UPDATE "turn_records" SET "provider" = 'responses'`);
    await queryRunner.query(`ALTER TABLE "turn_records" ALTER COLUMN "provider" SET NOT NULL`);
    // Turn ids are only unique within one provider, so the key must carry both.
    await queryRunner.query(`DROP INDEX "public"."uq_turn_records_openai_turn_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_turn_records_provider_turn_id" ON "turn_records" ("provider", "provider_turn_id")`,
    );

    // --- messages: history and deferred answers for providers with no memory
    await queryRunner.query(
      `CREATE TABLE "messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "conversation_id" uuid NOT NULL, "role" text NOT NULL, "content" text NOT NULL, "provider_turn_id" text, "model" text, "usage" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_messages_conversation_created_at" ON "messages" ("conversation_id", "created_at")`,
    );
    // Partial: only assistant rows carry a turn id, and many rows have none.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_messages_provider_turn_id" ON "messages" ("provider_turn_id") WHERE provider_turn_id IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_4838cd4fc48a6ff2d4aa01aa646" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_4838cd4fc48a6ff2d4aa01aa646"`);
    await queryRunner.query(`DROP INDEX "public"."uq_messages_provider_turn_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_conversation_created_at"`);
    await queryRunner.query(`DROP TABLE "messages"`);

    await queryRunner.query(`DROP INDEX "public"."uq_turn_records_provider_turn_id"`);
    await queryRunner.query(`ALTER TABLE "turn_records" DROP COLUMN "provider"`);
    await queryRunner.query(
      `ALTER TABLE "turn_records" RENAME COLUMN "provider_turn_id" TO "openai_turn_id"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_turn_records_openai_turn_id" ON "turn_records" ("openai_turn_id")`,
    );

    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "model"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "provider"`);
    await queryRunner.query(
      `ALTER INDEX "uq_conversations_provider_session_id" RENAME TO "uq_conversations_openai_session_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" RENAME COLUMN "provider_session_id" TO "openai_session_id"`,
    );
  }
}
