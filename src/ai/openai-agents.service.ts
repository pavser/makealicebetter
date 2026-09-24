import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionItem,
} from 'openai/resources/beta/agents/agents';
import type { Turn } from 'openai/resources/beta/agents/sessions/turns';

import type { AppConfig } from '../config/configuration.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { AiConversationProvider } from './ai-conversation.provider.js';
import {
  AgentConfigurationError,
  AgentSessionUnavailableError,
  type ConversationMeta,
  type RequiredAction,
  type SessionState,
  type TurnOutcome,
  type TurnUsage,
} from './types/ai.types.js';

/** How many recent session items to scan when looking for a turn's final answer. */
const ITEM_LOOKUP_LIMIT = 50;

interface EventSubscription {
  events: AsyncIterable<AgentSessionEvent>;
  abort: () => void;
}

/**
 * Production implementation backed by `client.beta.agents` (Agents API beta).
 *
 * Two invariants shape this class:
 *  - a session is durable, so we never resend history — the session *is* the history;
 *  - we may stop listening, but we never cancel a turn: OpenAI keeps running it
 *    and the result is recovered later from turns/items.
 */
@Injectable()
export class OpenAIAgentsService extends AiConversationProvider {
  private readonly logger = new Logger(OpenAIAgentsService.name);
  private readonly agentId: string;

  constructor(
    // Injected rather than constructed here so tests can pass a stub client.
    private readonly client: OpenAI,
    config: ConfigService<AppConfig, true>,
    private readonly tools: ToolRegistryService,
  ) {
    super();
    this.agentId = config.get('openai', { infer: true }).agentId;
  }

  static createClient(config: ConfigService<AppConfig, true>): OpenAI {
    const openai = config.get('openai', { infer: true });
    return new OpenAI({
      apiKey: openai.apiKey,
      timeout: openai.requestTimeoutMs,
      // Retrying a submitted message could duplicate a user turn; one retry of
      // the connection attempt is enough for our latency budget.
      maxRetries: 1,
    });
  }

  async createConversation(input: string, meta: ConversationMeta): Promise<{ sessionId: string }> {
    try {
      const session = await this.client.beta.agents.sessions.create({
        agent_id: this.agentId,
        // No OpenAI-hosted sandbox: this assistant only talks.
        environment: { type: 'none' },
        input,
        metadata: { alice_user: meta.userHash },
      });
      return { sessionId: session.id };
    } catch (error) {
      throw this.translateError(error, 'create session');
    }
  }

  async awaitCurrentTurn(sessionId: string, timeoutMs: number): Promise<TurnOutcome> {
    let subscription: EventSubscription;
    try {
      const stream = await this.client.beta.agents.sessions.events.stream(sessionId);
      subscription = { events: stream, abort: () => stream.controller.abort() };
    } catch (error) {
      throw this.translateError(error, 'subscribe to session events');
    }
    return this.consume(sessionId, subscription, timeoutMs);
  }

  async sendMessage(sessionId: string, input: string, timeoutMs: number): Promise<TurnOutcome> {
    // `sessions.stream` submits the input and follows the turn it starts.
    // Breaking out of the iteration closes our connection without cancelling the turn.
    const stream = this.client.beta.agents.sessions.stream(sessionId, {
      input,
      toolHandlers: this.tools.handlers(),
    });
    return this.consume(sessionId, { events: stream, abort: () => stream.abort() }, timeoutMs);
  }

  async getTurnOutcome(sessionId: string, turnId: string | null): Promise<TurnOutcome> {
    let turn: Turn | undefined;
    try {
      if (turnId) {
        turn = await this.client.beta.agents.sessions.turns.retrieve(turnId, {
          session_id: sessionId,
        });
      } else {
        const page = await this.client.beta.agents.sessions.turns.list(sessionId, {
          limit: 1,
          order: 'desc',
        });
        turn = page.data[0];
      }
    } catch (error) {
      throw this.translateError(error, 'read turn');
    }

    if (!turn) {
      return { state: 'running', sessionId, turnId };
    }

    switch (turn.status) {
      case 'completed': {
        const text = await this.findFinalAnswer(sessionId, turn.id);
        return {
          state: 'completed',
          sessionId,
          turnId: turn.id,
          text,
          usage: this.mapUsage(turn.usage),
          model: null,
        };
      }
      case 'failed':
        return {
          state: 'failed',
          sessionId,
          turnId: turn.id,
          error: turn.error?.message ?? 'turn failed',
        };
      case 'cancelled':
        return { state: 'cancelled', sessionId, turnId: turn.id, error: 'turn cancelled' };
      default:
        // queued | in_progress | waiting — still working on OpenAI's side.
        return { state: 'running', sessionId, turnId: turn.id };
    }
  }

  async getSessionState(sessionId: string): Promise<SessionState> {
    try {
      const session = await this.client.beta.agents.sessions.retrieve(sessionId);
      return this.mapSessionState(session);
    } catch (error) {
      throw this.translateError(error, 'read session');
    }
  }

  async resolveRequiredActions(sessionId: string, actions: RequiredAction[]): Promise<void> {
    const events = [];

    for (const action of actions) {
      if (action.type !== 'function_call') {
        // environment.type is 'none', so an environment connection request means
        // the agent is configured for a sandbox we do not provide.
        this.logger.warn(
          `Session ${sessionId} requires an unsupported action: ${action.type}; ignoring`,
        );
        continue;
      }

      const result = await this.tools.execute(action.name, action.arguments);
      events.push({
        type: 'agent.session.input.tool_result' as const,
        call_id: action.callId,
        turn_id: action.turnId,
        success: result.success,
        ...(result.success
          ? { output: JSON.stringify(result.output ?? null) }
          : { error: result.error ?? 'Tool execution failed' }),
      });
    }

    if (events.length === 0) {
      return;
    }

    try {
      await this.client.beta.agents.sessions.events.create(sessionId, { events });
    } catch (error) {
      this.logger.error(
        `Failed to submit tool results for session ${sessionId}: ${this.describe(error)}`,
      );
    }
  }

  async updateModel(sessionId: string, model: string): Promise<void> {
    try {
      await this.client.beta.agents.sessions.update(sessionId, { agent: { model } });
    } catch (error) {
      throw this.translateError(error, 'update session model');
    }
  }

  async validateAgent(): Promise<void> {
    try {
      await this.client.beta.agents.retrieve(this.agentId);
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
   * Follows session events until the turn reaches a terminal state or the
   * deadline passes. On timeout the iteration is aborted locally and the turn
   * keeps running remotely — that is what makes the deferred flow safe.
   */
  private async consume(
    sessionId: string,
    subscription: EventSubscription,
    timeoutMs: number,
  ): Promise<TurnOutcome> {
    let turnId: string | null = null;
    let finalText = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      subscription.abort();
    }, timeoutMs);

    try {
      for await (const event of subscription.events) {
        switch (event.type) {
          case 'agent.session.turn.created':
            turnId = event.turn_id;
            break;

          case 'agent.session.turn.item.done': {
            const text = this.extractFinalAnswer(event.item);
            if (text) {
              finalText = text;
            }
            break;
          }

          case 'agent.session.turn.completed': {
            const text = finalText || (await this.findFinalAnswer(sessionId, event.turn.id));
            return {
              state: 'completed',
              sessionId,
              turnId: event.turn.id,
              text,
              usage: this.mapUsage(event.usage ?? event.turn.usage),
              model: null,
            };
          }

          case 'agent.session.turn.failed':
            return {
              state: 'failed',
              sessionId,
              turnId: event.turn_id,
              error: event.turn.error?.message ?? 'turn failed',
            };

          case 'agent.session.turn.cancelled':
            return {
              state: 'cancelled',
              sessionId,
              turnId: event.turn_id,
              error: 'turn cancelled',
            };

          case 'agent.session.requires_action':
            // Answer the agent so the session never stays blocked on us.
            await this.resolveRequiredActions(
              sessionId,
              this.mapSessionState(event.session).requiredActions,
            );
            break;

          case 'agent.session.idle': {
            // "An idle session alone does not mean the turn succeeded" — and an
            // idle event can also arrive before our turn even starts, so ask for
            // the turn's real state and keep listening while it is still running.
            const outcome = await this.getTurnOutcome(sessionId, turnId);
            if (outcome.state !== 'running') {
              return outcome;
            }
            break;
          }

          case 'agent.session.failed':
            return {
              state: 'failed',
              sessionId,
              turnId,
              error: event.session.error ?? 'session failed',
            };

          default:
            break;
        }
      }
    } catch (error) {
      if (!timedOut) {
        this.logger.warn(`Event stream for session ${sessionId} ended: ${this.describe(error)}`);
        // The stream broke but the turn may well be fine — ask the API.
        return this.getTurnOutcome(sessionId, turnId);
      }
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      return { state: 'running', sessionId, turnId };
    }

    // Iteration finished without a terminal turn event (for example the session
    // went idle): the saved state is authoritative.
    return this.getTurnOutcome(sessionId, turnId);
  }

  /** Reads a completed turn's answer from the saved items — the recovery path after a disconnect. */
  private async findFinalAnswer(sessionId: string, turnId: string): Promise<string> {
    try {
      const page = await this.client.beta.agents.sessions.items.list(sessionId, {
        limit: ITEM_LOOKUP_LIMIT,
        order: 'desc',
      });

      let fallback = '';
      for (const item of page.data) {
        if (item.type !== 'message' || item.role !== 'assistant' || item.turn_id !== turnId) {
          continue;
        }
        const text = this.extractText(item);
        if (item.phase === 'final_answer' && text) {
          return text;
        }
        if (!fallback && text) {
          fallback = text;
        }
      }
      return fallback;
    } catch (error) {
      this.logger.warn(`Failed to read items for session ${sessionId}: ${this.describe(error)}`);
      return '';
    }
  }

  private extractFinalAnswer(item: AgentSessionItem): string {
    if (item.type !== 'message' || item.role !== 'assistant' || item.phase !== 'final_answer') {
      return '';
    }
    return this.extractText(item);
  }

  private extractText(item: Extract<AgentSessionItem, { type: 'message' }>): string {
    return item.content
      .filter((part): part is Extract<typeof part, { type: 'output_text' }> =>
        Boolean(part && typeof part === 'object' && 'type' in part && part.type === 'output_text'),
      )
      .map((part) => part.text)
      .join('')
      .trim();
  }

  private mapSessionState(session: AgentSession): SessionState {
    return {
      sessionId: session.id,
      status: session.status,
      model: session.agent.model,
      requiredActions: session.required_actions.map((action) =>
        action.type === 'function_call'
          ? {
              type: 'function_call',
              callId: action.call_id,
              name: action.name,
              arguments: action.arguments,
              turnId: action.turn_id,
            }
          : { type: 'environment_connection', environmentId: action.environment_id },
      ),
    };
  }

  private mapUsage(usage: Turn['usage']): TurnUsage | null {
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
    if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) {
      return new AgentConfigurationError(
        `Failed to ${action}: the API key lacks Agents API permissions (api.agents.read, api.agents.write, api.responses.write)`,
      );
    }
    return error instanceof Error ? error : new Error(`Failed to ${action}: ${String(error)}`);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
