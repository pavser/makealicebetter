import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { TurnOutcome } from '../ai/types/ai.types.js';
import type { AiProvider } from '../config/env.validation.js';
import {
  TurnRecordEntity,
  type TurnRecordStatus,
} from '../conversations/entities/turn-record.entity.js';

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelUsage extends UsageTotals {
  model: string;
  /** Two providers can serve the same model name; keep their rows apart. */
  provider: AiProvider;
}

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  models: ModelUsage[];
}

interface RecordTurnOptions {
  conversationId: string;
  outcome: TurnOutcome;
  latencyMs: number | null;
  deferred: boolean;
  model?: string | null;
  /** Part of the idempotency key — turn ids collide across providers. */
  provider: AiProvider;
}

/**
 * Persists per-turn usage and answers the admin dashboard queries.
 *
 * Writes are idempotent on (`provider`, `provider_turn_id`): a turn first seen
 * as `running` (deferred answer) is completed in place once its real outcome is
 * known, so no usage is lost and no duplicate rows appear. The provider is part
 * of the key because turn ids are only unique within one provider.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(TurnRecordEntity)
    private readonly turns: Repository<TurnRecordEntity>,
  ) {}

  async recordTurn(options: RecordTurnOptions): Promise<void> {
    const { conversationId, provider, outcome, latencyMs, deferred } = options;
    if (!outcome.turnId) {
      // Nothing to reconcile against later; skip rather than create an orphan row.
      return;
    }

    const status: TurnRecordStatus = outcome.state;
    const usage = outcome.state === 'completed' ? outcome.usage : null;
    const model = (outcome.state === 'completed' ? outcome.model : null) ?? options.model ?? null;

    try {
      await this.turns.upsert(
        {
          conversationId,
          provider,
          providerTurnId: outcome.turnId,
          status,
          model,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          reasoningTokens: usage?.reasoningTokens ?? null,
          cachedTokens: usage?.cachedTokens ?? null,
          latencyMs,
          deferred,
          completedAt: status === 'running' ? null : new Date(),
        },
        { conflictPaths: ['provider', 'providerTurnId'] },
      );
    } catch (error) {
      // Usage accounting must never break a voice answer.
      this.logger.warn(`Failed to record turn ${outcome.turnId}: ${this.describe(error)}`);
    }
  }

  async getSummary(): Promise<UsageSummary> {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [today, month, models] = await Promise.all([
      this.totalsSince(startOfToday),
      this.totalsSince(startOfMonth),
      this.modelBreakdown(startOfMonth),
    ]);

    return { today, month, models };
  }

  async countActiveUsers(since: Date): Promise<number> {
    const row = await this.turns
      .createQueryBuilder('turn')
      .innerJoin('conversations', 'conversation', 'conversation.id = turn.conversation_id')
      .select('COUNT(DISTINCT conversation.user_id)', 'count')
      .where('turn.created_at >= :since', { since })
      .getRawOne<{ count: string }>();

    return Number(row?.count ?? 0);
  }

  private async totalsSince(since: Date): Promise<UsageTotals> {
    const row = await this.turns
      .createQueryBuilder('turn')
      .select('COUNT(*)', 'requests')
      .addSelect('COALESCE(SUM(turn.input_tokens), 0)', 'inputTokens')
      .addSelect('COALESCE(SUM(turn.output_tokens), 0)', 'outputTokens')
      .where('turn.created_at >= :since', { since })
      .getRawOne<{ requests: string; inputTokens: string; outputTokens: string }>();

    return {
      requests: Number(row?.requests ?? 0),
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
    };
  }

  private async modelBreakdown(since: Date): Promise<ModelUsage[]> {
    const rows = await this.turns
      .createQueryBuilder('turn')
      .select('turn.model', 'model')
      .addSelect('turn.provider', 'provider')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COALESCE(SUM(turn.input_tokens), 0)', 'inputTokens')
      .addSelect('COALESCE(SUM(turn.output_tokens), 0)', 'outputTokens')
      .where('turn.created_at >= :since', { since })
      .andWhere('turn.model IS NOT NULL')
      .groupBy('turn.model')
      .addGroupBy('turn.provider')
      .orderBy('requests', 'DESC')
      .getRawMany<{
        model: string;
        provider: AiProvider;
        requests: string;
        inputTokens: string;
        outputTokens: string;
      }>();

    return rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
    }));
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
