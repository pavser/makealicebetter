import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { Reasoning } from 'openai/resources/shared';
import type { ResponseTextConfig, Tool } from 'openai/resources/responses/responses';

import type { AppConfig } from '../config/configuration.js';
import { AiConversationProvider } from './ai-conversation.provider.js';
import {
  AgentConfigurationError,
  AgentSessionUnavailableError,
  type ConversationMeta,
  type SessionState,
  type TurnOutcome,
  type TurnUsage,
} from './types/ai.types.js';

/** How many recent conversation items to scan when recovering an answer. */
const ITEM_LOOKUP_LIMIT = 20;

/** Reading saved state is a quick call; anything slower is not worth Alice's budget. */
const LOOKUP_TIMEOUT_MS = 2_000;

/** Floor for per-call timeouts, so a tiny remaining budget cannot abort instantly. */
const MIN_CALL_TIMEOUT_MS = 800;

// Note: every hot-path call also sets `maxRetries: 0`. The SDK retries a timed
// out request by default, which doubles the wait and pushes us past Alice's
// limit — measured 5.6s on a 2.5s budget before this was fixed.

/**
 * Fast path: the Responses API driven by the configuration of the saved agent.
 *
 * Same contract as {@link OpenAIAgentsService} — the conversation lives on
 * OpenAI's side and we never resend history — but answers arrive in seconds
 * instead of the Agents API's ~12s, which is what Alice's 4.5s limit demands.
 * Measured on the production host: 1.4-2.7s here against 12.1s there.
 *
 * Model, instructions and tools still come from the saved agent, so everything
 * stays configurable in the OpenAI Platform UI.
 */
@Injectable()
export class OpenAIResponsesService extends AiConversationProvider {
  private readonly logger = new Logger(OpenAIResponsesService.name);
  private readonly agentId: string;
  private agentConfig: {
    model: string;
    instructions: string | null;
    tools: Tool[];
    reasoning: Reasoning | null;
    text: ResponseTextConfig | null;
  } | null = null;

  constructor(
    private readonly client: OpenAI,
    config: ConfigService<AppConfig, true>,
  ) {
    super();
    this.agentId = config.get('openai', { infer: true }).agentId;
  }

  async startConversation(
    input: string,
    meta: ConversationMeta,
    timeoutMs: number,
    onSessionCreated: (conversationId: string) => Promise<void>,
  ): Promise<TurnOutcome> {
    const deadline = Date.now() + timeoutMs;

    let conversationId: string;
    try {
      const conversation = await this.client.conversations.create(
        { metadata: { alice_user: meta.userHash } },
        { timeout: Math.max(timeoutMs, MIN_CALL_TIMEOUT_MS), maxRetries: 0 },
      );
      conversationId = conversation.id;
    } catch (error) {
      throw this.translateError(error, 'create conversation');
    }

    // Persist before answering: a conversation we cannot reach again is lost.
    await onSessionCreated(conversationId);

    return this.respond(conversationId, input, deadline - Date.now());
  }

  async sendMessage(
    conversationId: string,
    input: string,
    timeoutMs: number,
  ): Promise<TurnOutcome> {
    this.assertOwnConversation(conversationId);
    return this.respond(conversationId, input, timeoutMs);
  }

  async getTurnOutcome(
    conversationId: string,
    _responseId: string | null,
    notBeforeMs?: number,
  ): Promise<TurnOutcome> {
    this.assertOwnConversation(conversationId);
    // The answer is appended to the conversation even when our request was cut
    // short, so the saved items are the source of truth — no response id needed.
    const text = await this.findAnswer(conversationId, notBeforeMs);

    if (!text) {
      return { state: 'running', sessionId: conversationId, turnId: null };
    }

    return {
      state: 'completed',
      sessionId: conversationId,
      turnId: null,
      text,
      // Usage for a deferred answer is not retrievable without the response id;
      // the direct path records it instead.
      usage: null,
      model: this.agentConfig?.model ?? null,
    };
  }

  getSessionState(conversationId: string): Promise<SessionState> {
    // A Responses conversation has no long-running turn to be busy with: every
    // answer either arrived on the request or is already saved.
    return Promise.resolve({
      sessionId: conversationId,
      status: 'idle',
      model: this.agentConfig?.model ?? null,
      requiredActions: [],
    });
  }

  resolveRequiredActions(): Promise<void> {
    // Built-in tools run on OpenAI's side; nothing is ever handed back to us.
    return Promise.resolve();
  }

  updateModel(): Promise<void> {
    // The model comes from the saved agent; per-conversation switching would
    // need its own storage and is deliberately left out.
    return Promise.resolve();
  }

  async validateAgent(): Promise<void> {
    try {
      const agent = await this.client.beta.agents.retrieve(this.agentId);
      this.agentConfig = {
        model: agent.model,
        instructions: agent.instructions,
        tools: this.mapTools(agent),
        // Passing these through matters for latency, not just style: the
        // agent's `reasoning: low` answers in ~2s, the model's own default in
        // ~4.3s — measured on the production host.
        reasoning: agent.reasoning ? { effort: agent.reasoning.effort } : null,
        text: agent.text?.verbosity ? { verbosity: agent.text.verbosity } : null,
      };
      this.logger.log(
        `Using saved agent "${agent.name ?? this.agentId}" (model ${agent.model}, ` +
          `reasoning ${agent.reasoning?.effort ?? 'default'}) through the Responses API`,
      );
    } catch (error) {
      if (error instanceof OpenAI.APIError && error.status === 404) {
        throw new AgentConfigurationError(
          `OPENAI_AGENT_ID "${this.agentId}" was not found. Create an agent in the OpenAI Platform and update the variable.`,
        );
      }
      throw this.translateError(error, 'validate agent');
    }
  }

  /**
   * Rejects ids created by the Agents path (`sess_…`).
   *
   * Switching AI_PROVIDER leaves such ids in Postgres, and the API answers them
   * with a 400. Reporting them as unavailable makes the caller archive the old
   * conversation and open a fresh one, which is exactly the right migration.
   */
  private assertOwnConversation(conversationId: string): void {
    if (!conversationId.startsWith('conv')) {
      throw new AgentSessionUnavailableError(
        `Conversation "${conversationId}" belongs to another provider`,
      );
    }
  }

  private async respond(
    conversationId: string,
    input: string,
    timeoutMs: number,
  ): Promise<TurnOutcome> {
    const config = await this.requireAgentConfig();
    // The deadline covers opening the stream too: establishing the connection
    // costs about a second, and starting the clock afterwards spends that much
    // of Alice's budget twice over.
    const deadline = Date.now() + timeoutMs;

    let stream;
    try {
      // Streamed so we can tell *why* an answer is slow: a web search takes
      // about three seconds on its own, and saying so is friendlier than a
      // generic "нужно ещё немного времени".
      stream = await this.client.responses.create(
        {
          model: config.model,
          instructions: config.instructions,
          conversation: conversationId,
          input,
          tools: config.tools,
          ...(config.reasoning ? { reasoning: config.reasoning } : {}),
          ...(config.text ? { text: config.text } : {}),
          store: true,
          stream: true,
        },
        { timeout: Math.max(timeoutMs, MIN_CALL_TIMEOUT_MS), maxRetries: 0 },
      );
    } catch (error) {
      throw this.translateError(error, 'create response');
    }

    let responseId: string | null = null;
    let searching = false;
    let timedOut = false;
    // `output_text` is a helper the SDK computes for a plain response; in a
    // stream it is absent, so the text is assembled from the deltas.
    let text = '';

    const timer = setTimeout(
      () => {
        timedOut = true;
        stream.controller.abort();
      },
      Math.max(deadline - Date.now(), 1),
    );

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'response.created':
            responseId = event.response.id;
            break;

          case 'response.web_search_call.in_progress':
          case 'response.web_search_call.searching':
            searching = true;
            break;

          case 'response.output_text.delta':
            text += event.delta;
            break;

          case 'response.completed':
            return {
              state: 'completed',
              sessionId: conversationId,
              turnId: event.response.id,
              text: text.trim() || this.extractResponseText(event.response),
              usage: this.mapUsage(event.response.usage),
              model: config.model,
            };

          case 'response.failed':
          case 'response.incomplete':
            return {
              state: 'failed',
              sessionId: conversationId,
              turnId: event.response.id,
              error: event.response.error?.message ?? 'response failed',
            };

          default:
            break;
        }
      }
    } catch (error) {
      if (!timedOut) {
        throw this.translateError(error, 'read response stream');
      }
    } finally {
      clearTimeout(timer);
    }

    // Out of budget: generation continues and the answer is appended to the
    // conversation, so the follow-up will collect it.
    this.logger.log(
      `Deferring answer for ${conversationId}${searching ? ' (web search in progress)' : ''}`,
    );
    return { state: 'running', sessionId: conversationId, turnId: responseId, searching };
  }

  /** Falls back to the response payload when no text deltas were seen. */
  private extractResponseText(response: OpenAI.Responses.Response): string {
    return (response.output ?? [])
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .map((part) => (part.type === 'output_text' ? part.text : ''))
      .join('')
      .trim();
  }

  /** Finds the latest assistant message written after the question was asked. */
  private async findAnswer(conversationId: string, notBeforeMs?: number): Promise<string> {
    let items;
    try {
      items = await this.client.conversations.items.list(
        conversationId,
        { order: 'desc', limit: ITEM_LOOKUP_LIMIT },
        { timeout: LOOKUP_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (error) {
      throw this.translateError(error, 'read conversation');
    }

    for (const item of items.data) {
      if (item.type !== 'message' || item.role !== 'assistant') {
        continue;
      }
      if (notBeforeMs && !this.isAfter(item, notBeforeMs)) {
        // Older than the question we are waiting for — stop before replaying
        // an answer the user has already heard.
        break;
      }
      const text = this.extractText(item);
      if (text) {
        return text;
      }
    }

    return '';
  }

  private isAfter(item: unknown, notBeforeMs: number): boolean {
    const createdAt =
      item && typeof item === 'object' && 'created_at' in item ? item.created_at : undefined;
    if (typeof createdAt !== 'number') {
      // No timestamp to judge by: treat it as current rather than lose the answer.
      return true;
    }
    return createdAt * 1000 >= notBeforeMs - 1_000;
  }

  private extractText(item: { content?: unknown }): string {
    const content: unknown[] = Array.isArray(item.content) ? item.content : [];
    const parts = content.map((part): string => {
      if (!part || typeof part !== 'object' || !('text' in part)) {
        return '';
      }
      const { text } = part;
      return typeof text === 'string' ? text : '';
    });
    return parts.join('').trim();
  }

  private mapTools(agent: { tools?: Array<{ type: string }> }): Tool[] {
    // Only the built-in tools carry over; function tools would need the agent's
    // own schemas, which the Responses API expects in a different shape.
    return (agent.tools ?? [])
      .filter((tool) => tool.type === 'web_search')
      .map((tool) => ({ type: tool.type }) as Tool);
  }

  private async requireAgentConfig(): Promise<NonNullable<typeof this.agentConfig>> {
    if (!this.agentConfig) {
      // Startup validation may have failed or not run yet.
      await this.validateAgent();
    }
    if (!this.agentConfig) {
      throw new AgentConfigurationError('Saved agent configuration is unavailable');
    }
    return this.agentConfig;
  }

  private mapUsage(usage: OpenAI.Responses.Response['usage']): TurnUsage | null {
    if (!usage) {
      return null;
    }
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
      cachedTokens: usage.input_tokens_details?.cached_tokens ?? null,
    };
  }

  private translateError(error: unknown, action: string): Error {
    if (error instanceof OpenAI.APIError && error.status === 404) {
      return new AgentSessionUnavailableError(`Failed to ${action}: not found`);
    }
    if (
      error instanceof OpenAI.APIError &&
      error.status === 400 &&
      /conversation/i.test(error.message)
    ) {
      // The stored id is not one we can talk to — start over rather than fail.
      return new AgentSessionUnavailableError(`Failed to ${action}: ${error.message}`);
    }
    if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) {
      return new AgentConfigurationError(
        `Failed to ${action}: the API key lacks the required permissions`,
      );
    }
    return error instanceof Error ? error : new Error(`Failed to ${action}: ${String(error)}`);
  }
}
