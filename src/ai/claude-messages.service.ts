import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageCreateParams,
  MessageParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config/configuration.js';
import { AiProvider } from '../config/env.validation.js';
import { ConversationHistoryService } from '../conversations/conversation-history.service.js';
import { AiConversationProvider } from './ai-conversation.provider.js';
import {
  ConversationUnavailableError,
  ProviderConfigurationError,
  type ConversationMeta,
  type SessionState,
  type TurnOutcome,
  type TurnUsage,
} from './types/ai.types.js';

/** Marks conversation ids issued here, so another provider's id is spotted at once. */
const SESSION_PREFIX = 'claude_';

/** Floor for per-call timeouts, so a tiny remaining budget cannot abort instantly. */
const MIN_CALL_TIMEOUT_MS = 800;

/**
 * Anthropic path: the Messages API, with the conversation carried by us.
 *
 * Two properties of that API shape this whole class, and neither is a choice:
 *
 *  1. **It is stateless.** Nothing is remembered between calls, so every
 *     question resends the tail of the conversation from Postgres.
 *  2. **A finished answer cannot be fetched afterwards.** There is no
 *     "retrieve message by id", so an answer that arrives after Alice's 4.5s
 *     budget exists only inside our own stream. We therefore keep reading it in
 *     the background and store the result, instead of dropping the connection.
 *
 * The cost of (2) is honest and worth stating: a restart mid-generation loses
 * that answer, where the OpenAI path would still have it. The user hears a
 * plain "couldn't get it" and asks again.
 */
@Injectable()
export class ClaudeMessagesService extends AiConversationProvider {
  readonly name = AiProvider.Claude;

  private readonly logger = new Logger(ClaudeMessagesService.name);
  private readonly settings: AppConfig['ai']['anthropic'];
  private readonly systemPrompt: string;

  /**
   * Turns whose stream is still being read in this process.
   *
   * Only meaningful while the process lives — which is exactly the guarantee
   * the Messages API gives us. A turn missing from here and from storage is
   * reported as failed rather than left pending forever.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    // Injected rather than constructed here so tests can pass a stub client.
    private readonly client: Anthropic,
    private readonly history: ConversationHistoryService,
    config: ConfigService<AppConfig, true>,
    systemPrompt: string,
  ) {
    super();
    this.settings = config.get('ai', { infer: true }).anthropic;
    this.systemPrompt = systemPrompt;
  }

  async startConversation(
    input: string,
    _meta: ConversationMeta,
    timeoutMs: number,
    onSessionCreated: (sessionId: string) => Promise<void>,
  ): Promise<TurnOutcome> {
    const deadline = Date.now() + timeoutMs;
    // There is no remote conversation to create, so the id is ours. It still
    // has to be persisted before we answer: without the row the next question
    // would start from nothing.
    const sessionId = `${SESSION_PREFIX}${randomUUID()}`;
    await onSessionCreated(sessionId);

    return this.respond(sessionId, input, deadline - Date.now(), []);
  }

  async sendMessage(sessionId: string, input: string, timeoutMs: number): Promise<TurnOutcome> {
    this.assertOwnConversation(sessionId);
    const deadline = Date.now() + timeoutMs;
    const history = await this.history.recentMessages(sessionId, this.settings.historyMessages);

    return this.respond(sessionId, input, deadline - Date.now(), history);
  }

  async getTurnOutcome(sessionId: string, turnId: string | null): Promise<TurnOutcome> {
    this.assertOwnConversation(sessionId);

    if (!turnId) {
      return { state: 'running', sessionId, turnId: null };
    }

    const stored = await this.history.findAnswer(turnId);
    if (stored) {
      return {
        state: 'completed',
        sessionId,
        turnId,
        text: stored.text,
        usage: stored.usage,
        model: stored.model,
      };
    }

    if (this.inFlight.has(turnId)) {
      return { state: 'running', sessionId, turnId };
    }

    // Neither finished nor being read: the stream died with the process. The
    // answer is unrecoverable, so say so instead of waiting forever.
    return {
      state: 'failed',
      sessionId,
      turnId,
      error: 'The answer was lost before it finished',
    };
  }

  getSessionState(sessionId: string): Promise<SessionState> {
    this.assertOwnConversation(sessionId);
    return Promise.resolve({
      sessionId,
      // Turns are tracked per id, not per conversation; a conversation itself
      // is never busy in a way the caller could act on.
      status: 'idle',
      model: null,
      requiredActions: [],
    });
  }

  resolveRequiredActions(): Promise<void> {
    // Web search runs on Anthropic's side; no local tools are registered yet.
    return Promise.resolve();
  }

  updateModel(): Promise<void> {
    // The chosen model is stored on the conversation row by the caller — the
    // Messages API has nothing to update.
    return Promise.resolve();
  }

  modelProfiles(): { fast?: string; smart?: string } {
    return { fast: this.settings.modelFast, smart: this.settings.modelSmart };
  }

  async validateConfiguration(): Promise<void> {
    try {
      const model = await this.client.models.retrieve(this.settings.modelFast);
      this.logger.log(
        `Using Anthropic model ${model.id} (smart: ${this.settings.modelSmart}, ` +
          `web search ${this.settings.webSearch ? 'on' : 'off'})`,
      );
    } catch (error) {
      if (error instanceof Anthropic.APIError && error.status === 404) {
        throw new ProviderConfigurationError(
          `ANTHROPIC_MODEL_FAST "${this.settings.modelFast}" was not found. Check the model id.`,
        );
      }
      throw this.translateError(error, 'validate model');
    }
  }

  /**
   * Sends one turn and waits for it up to `timeoutMs`.
   *
   * The stream is never aborted. Dropping it would throw away the only copy of
   * the answer — unlike the OpenAI path, where the turn keeps running remotely.
   */
  private async respond(
    sessionId: string,
    input: string,
    timeoutMs: number,
    history: readonly { role: 'user' | 'assistant'; content: string }[],
  ): Promise<TurnOutcome> {
    const startedAt = Date.now();
    const model = await this.resolveModel(sessionId);
    const messages: MessageParam[] = [
      ...history.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user' as const, content: input },
    ];

    // Recorded before the answer so a lost turn still leaves the question in
    // the history — the next reply would be answering a blank otherwise.
    void this.history
      .appendUserMessage(sessionId, input)
      .catch((error: unknown) =>
        this.logger.warn(`Failed to store the question: ${this.describe(error)}`),
      );

    let stream;
    try {
      stream = this.client.messages.stream(this.buildRequest(model, messages), {
        timeout: Math.max(timeoutMs, MIN_CALL_TIMEOUT_MS),
        maxRetries: 0,
      });
    } catch (error) {
      throw this.translateError(error, 'start turn');
    }

    let turnId: string | null = null;
    let searching = false;
    let text = '';

    const reading = (async (): Promise<TurnOutcome> => {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            turnId = event.message.id;
            this.inFlight.add(turnId);
            break;
          case 'content_block_start':
            if (
              event.content_block.type === 'server_tool_use' &&
              event.content_block.name === 'web_search'
            ) {
              // Worth telling the user: it explains the wait instead of
              // sounding like the skill stalled.
              searching = true;
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              text += event.delta.text;
            }
            break;
          default:
            break;
        }
      }

      const finalMessage = await stream.finalMessage();
      const answer = {
        text: text.trim() || this.extractText(finalMessage.content),
        model: finalMessage.model,
        usage: this.mapUsage(finalMessage.usage),
      };

      if (finalMessage.id) {
        await this.history.appendAssistantMessage(sessionId, finalMessage.id, answer);
        this.inFlight.delete(finalMessage.id);
      }

      return {
        state: 'completed',
        sessionId,
        turnId: finalMessage.id,
        text: answer.text,
        usage: answer.usage,
        model: answer.model,
      };
    })();

    const untilDeadline = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), Math.max(timeoutMs, 0)).unref?.();
    });

    const outcome = await Promise.race([
      reading.catch((error: unknown) => {
        if (turnId) {
          this.inFlight.delete(turnId);
        }
        throw this.translateError(error, 'read turn');
      }),
      untilDeadline,
    ]);

    if (outcome) {
      return outcome;
    }

    // Out of budget. The read continues; its result lands in storage and the
    // follow-up ("ну что") picks it up by id.
    void reading
      .then((completed) =>
        this.logger.log(
          `Deferred answer ready for ${completed.turnId ?? 'unknown turn'} ` +
            `after ${Date.now() - startedAt}ms`,
        ),
      )
      .catch((error: unknown) => {
        if (turnId) {
          this.inFlight.delete(turnId);
        }
        this.logger.warn(`Deferred answer failed: ${this.describe(error)}`);
      });

    return { state: 'running', sessionId, turnId, searching };
  }

  private buildRequest(model: string, messages: MessageParam[]): MessageCreateParams {
    return {
      model,
      max_tokens: this.settings.maxTokens,
      // The breakpoint is free but currently inert: prompt caching needs a
      // prefix of a few thousand tokens, and the voice prompt is ~370 — measured
      // `cache_creation_input_tokens: 0` on every real request. Kept so a longer
      // prompt starts paying off by itself, not because it saves anything today.
      system: [
        {
          type: 'text',
          text: this.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
      ...(this.settings.webSearch
        ? {
            tools: [
              {
                type: 'web_search_20260318' as const,
                name: 'web_search' as const,
                // Without this the tool defaults to programmatic calling, which
                // Haiku does not support — the request fails with a 400 before
                // a single token is generated.
                allowed_callers: ['direct' as const],
              },
            ],
          }
        : {}),
    };
  }

  /** Falls back to the fast model when the conversation has no preference. */
  private async resolveModel(sessionId: string): Promise<string> {
    const stored = await this.history.findConversationModel(sessionId);
    return stored ?? this.settings.modelFast;
  }

  private extractText(content: readonly { type: string }[]): string {
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  private mapUsage(usage: Usage | null | undefined): TurnUsage | null {
    if (!usage) {
      return null;
    }

    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? null,
      cachedTokens: usage.cache_read_input_tokens ?? null,
    };
  }

  /**
   * Rejects ids created by the OpenAI paths (`conv_…`, `sess_…`).
   *
   * Switching provider leaves such ids in Postgres. Reporting them as
   * unavailable makes the caller archive the old conversation and open a fresh
   * one, which is the right migration — history cannot cross providers anyway.
   */
  private assertOwnConversation(sessionId: string): void {
    if (!sessionId.startsWith(SESSION_PREFIX)) {
      throw new ConversationUnavailableError(
        `Conversation "${sessionId}" belongs to another provider`,
      );
    }
  }

  private translateError(error: unknown, action: string): Error {
    if (error instanceof Anthropic.APIError) {
      // Anthropic explains 4xx properly ("credit balance is too low", "model
      // not found"). Swallowing that leaves only a bare status in the log and
      // turns a five-second fix into an investigation, so it is logged here —
      // the user still hears a neutral phrase.
      this.logger.warn(`Anthropic rejected "${action}": ${error.status} ${this.apiMessage(error)}`);

      if (error.status === 401 || error.status === 403) {
        return new ProviderConfigurationError(
          `Failed to ${action}: the Anthropic API key was rejected`,
        );
      }
      if (error.status === 404) {
        return new ConversationUnavailableError(`Failed to ${action}: not found`);
      }
      return new Error(`Failed to ${action}: ${error.status ?? 'network'}`);
    }
    return error instanceof Error ? error : new Error(`Failed to ${action}`);
  }

  /** The API's own explanation, which describes the request, never its content. */
  private apiMessage(error: { error?: unknown; message: string }): string {
    const body = error.error as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? error.message;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
