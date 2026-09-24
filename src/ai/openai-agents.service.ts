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

/** How many recent turns to scan when the turn id is unknown. */
const TURN_LOOKUP_LIMIT = 10;

/**
 * Subscribing to a session costs about a round-trip, so below this much
 * remaining budget it is cheaper to answer "still working" right away.
 */
const MIN_LISTEN_MS = 1_000;

/** Floor for per-call timeouts, so a tiny remaining budget cannot abort instantly. */
const MIN_CALL_TIMEOUT_MS = 800;

/** Reading saved state is a quick call; anything slower is not worth Alice's budget. */
const LOOKUP_TIMEOUT_MS = 2_000;

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
  /**
   * The saved agent's model, learned once at startup and reported with usage.
   * A session switched by voice command reports the agent's default here — the
   * exact per-session model would cost an extra API call on every turn.
   */
  private agentModel: string | null = null;

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

  async startConversation(
    input: string,
    meta: ConversationMeta,
    timeoutMs: number,
    onSessionCreated: (sessionId: string) => Promise<void>,
  ): Promise<TurnOutcome> {
    // The deadline covers the create call itself: opening the session costs a
    // round-trip of its own, and starting the clock afterwards would blow the
    // caller's budget by exactly that much.
    const deadline = Date.now() + timeoutMs;

    let stream;
    try {
      // Streaming the creation gives us the session id, the turn id and the
      // answer on one connection. Creating first and subscribing afterwards
      // would cost a second round-trip and could miss the turn's first events.
      stream = await this.client.beta.agents.sessions.create(
        {
          agent_id: this.agentId,
          // No OpenAI-hosted sandbox: this assistant only talks.
          environment: { type: 'none' },
          input,
          metadata: { alice_user: meta.userHash },
          stream: true,
        },
        // Every call on the hot path carries the request's own deadline:
        // without it a slow API keeps Alice waiting past her 4.5s limit and
        // she drops the session with "навык не отвечает".
        { timeout: Math.max(timeoutMs, MIN_CALL_TIMEOUT_MS), maxRetries: 0 },
      );
    } catch (error) {
      throw this.translateError(error, 'create session');
    }

    return this.consume(
      null,
      { events: stream, abort: () => stream.controller.abort() },
      // A non-positive value is fine: consume still reads the session id first,
      // so the session is persisted before we hand back a deferred answer.
      deadline - Date.now(),
      onSessionCreated,
    );
  }

  async sendMessage(sessionId: string, input: string, timeoutMs: number): Promise<TurnOutcome> {
    // Ids left over from the Responses path (`conv_…`) belong to another API;
    // reporting them as unavailable makes the caller open a fresh session.
    if (!sessionId.startsWith('sess')) {
      throw new AgentSessionUnavailableError(`Session "${sessionId}" belongs to another provider`);
    }

    const deadline = Date.now() + timeoutMs;

    // The message goes out on its own request rather than through
    // `sessions.stream`. That helper submits the input lazily, as iteration
    // begins, so aborting on our deadline can cut the submission short and the
    // question is silently lost — verified against the live API. Here the 202
    // means the session has it, whatever we do next.
    try {
      await this.client.beta.agents.sessions.events.create(
        sessionId,
        {
          events: [
            {
              type: 'agent.session.input.message',
              input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
            },
          ],
        },
        { timeout: Math.max(timeoutMs, MIN_CALL_TIMEOUT_MS), maxRetries: 0 },
      );
    } catch (error) {
      throw this.translateError(error, 'submit message');
    }

    const remaining = deadline - Date.now();
    if (remaining < MIN_LISTEN_MS) {
      // Not enough time left for the extra round-trip a subscription costs.
      return { state: 'running', sessionId, turnId: null };
    }

    let stream;
    try {
      stream = await this.client.beta.agents.sessions.events.stream(sessionId, {
        timeout: Math.max(deadline - Date.now(), MIN_CALL_TIMEOUT_MS),
        maxRetries: 0,
      });
    } catch (error) {
      // The message is already accepted, so a failed subscription is not fatal.
      this.logger.warn(`Could not follow session ${sessionId}: ${this.describe(error)}`);
      return { state: 'running', sessionId, turnId: null };
    }

    return this.consume(
      sessionId,
      { events: stream, abort: () => stream.controller.abort() },
      deadline - Date.now(),
    );
  }

  async getTurnOutcome(
    sessionId: string,
    turnId: string | null,
    notBeforeMs?: number,
  ): Promise<TurnOutcome> {
    let turn: Turn | undefined;
    try {
      if (turnId) {
        turn = await this.client.beta.agents.sessions.turns.retrieve(
          turnId,
          { session_id: sessionId },
          { timeout: LOOKUP_TIMEOUT_MS, maxRetries: 0 },
        );
      } else {
        const page = await this.client.beta.agents.sessions.turns.list(
          sessionId,
          { limit: TURN_LOOKUP_LIMIT, order: 'desc' },
          { timeout: LOOKUP_TIMEOUT_MS, maxRetries: 0 },
        );
        turn = notBeforeMs
          ? // `created_at` is in seconds; the second of slack absorbs clock skew
            // between this host and OpenAI.
            page.data.find((candidate) => candidate.created_at * 1000 >= notBeforeMs - 1_000)
          : page.data[0];
      }
    } catch (error) {
      throw this.translateError(error, 'read turn');
    }

    if (!turn) {
      // Our turn does not exist yet — the API is still creating it.
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
          model: this.agentModel,
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
      const session = await this.client.beta.agents.sessions.retrieve(sessionId, {
        timeout: LOOKUP_TIMEOUT_MS,
        maxRetries: 0,
      });
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
      const agent = await this.client.beta.agents.retrieve(this.agentId);
      this.agentModel = agent.model ?? null;
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
    knownSessionId: string | null,
    subscription: EventSubscription,
    timeoutMs: number,
    onSessionCreated?: (sessionId: string) => Promise<void>,
  ): Promise<TurnOutcome> {
    let sessionId = knownSessionId;
    let turnId: string | null = null;
    let finalText = '';
    let timedOut = false;

    // Every turn event arrives after the session exists, so by the time any of
    // the branches below need the id it is always set. This keeps that
    // assumption explicit instead of scattering non-null assertions.
    const sid = (): string => {
      if (!sessionId) {
        throw new Error('Received a turn event before the session id was known');
      }
      return sessionId;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // When the session id is still unknown we must not drop the connection:
      // abandoning it here would leave a session nobody can ever reach again.
      // The abort happens right after the id arrives instead.
      if (sessionId) {
        subscription.abort();
      }
    }, timeoutMs);

    try {
      for await (const event of subscription.events) {
        switch (event.type) {
          case 'agent.session.created':
            sessionId = event.session.id;
            await onSessionCreated?.(sessionId);
            if (timedOut) {
              // The deadline passed while we were waiting for the id — stop now
              // that the session is safely persisted.
              subscription.abort();
            }
            break;

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
            const text = finalText || (await this.findFinalAnswer(sid(), event.turn.id));
            return {
              state: 'completed',
              sessionId: sid(),
              turnId: event.turn.id,
              text,
              usage: this.mapUsage(event.usage ?? event.turn.usage),
              model: this.agentModel,
            };
          }

          case 'agent.session.turn.failed':
            return {
              state: 'failed',
              sessionId: sid(),
              turnId: event.turn_id,
              error: event.turn.error?.message ?? 'turn failed',
            };

          case 'agent.session.turn.cancelled':
            return {
              state: 'cancelled',
              sessionId: sid(),
              turnId: event.turn_id,
              error: 'turn cancelled',
            };

          case 'agent.session.requires_action':
            // Answer the agent so the session never stays blocked on us.
            await this.resolveRequiredActions(
              sid(),
              this.mapSessionState(event.session).requiredActions,
            );
            break;

          case 'agent.session.idle': {
            // "An idle session alone does not mean the turn succeeded" — and an
            // idle event can also arrive before our turn even starts, so ask for
            // the turn's real state and keep listening while it is still running.
            const outcome = await this.getTurnOutcome(sid(), turnId);
            if (outcome.state !== 'running') {
              return outcome;
            }
            break;
          }

          case 'agent.session.failed':
            return {
              state: 'failed',
              sessionId: sid(),
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
        return this.getTurnOutcome(sid(), turnId);
      }
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      return { state: 'running', sessionId: sid(), turnId };
    }

    // Iteration finished without a terminal turn event (for example the session
    // went idle): the saved state is authoritative.
    return this.getTurnOutcome(sid(), turnId);
  }

  /** Reads a completed turn's answer from the saved items — the recovery path after a disconnect. */
  private async findFinalAnswer(sessionId: string, turnId: string): Promise<string> {
    try {
      const page = await this.client.beta.agents.sessions.items.list(
        sessionId,
        { limit: ITEM_LOOKUP_LIMIT, order: 'desc' },
        { timeout: LOOKUP_TIMEOUT_MS, maxRetries: 0 },
      );

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
