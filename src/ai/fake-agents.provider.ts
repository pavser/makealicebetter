import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AiConversationProvider } from './ai-conversation.provider.js';
import {
  AgentSessionUnavailableError,
  type ConversationMeta,
  type RequiredAction,
  type SessionState,
  type TurnOutcome,
} from './types/ai.types.js';

type FakeTurnState = 'completed' | 'failed' | 'cancelled';

interface FakeTurn {
  id: string;
  input: string;
  completesAt: number;
  finalState: FakeTurnState;
  requiresAction: boolean;
}

interface FakeSession {
  id: string;
  model: string;
  turns: FakeTurn[];
  messageCount: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));

/**
 * In-memory stand-in for the Agents API, used when `OPENAI_FAKE=true`.
 *
 * It reproduces the parts of the real contract the app depends on: a session
 * that remembers its history, turns that finish on their own schedule even when
 * nobody is waiting, and terminal states other than success.
 *
 * Behaviour is steered by env vars, read per request so scenarios can be
 * switched while the server runs:
 *   FAKE_DELAY_MS, FAKE_FAIL, FAKE_CANCEL, FAKE_REQUIRES_ACTION
 */
@Injectable()
export class FakeAgentsProvider extends AiConversationProvider {
  private readonly logger = new Logger(FakeAgentsProvider.name);
  private readonly sessions = new Map<string, FakeSession>();

  createConversation(input: string, meta: ConversationMeta): Promise<{ sessionId: string }> {
    const session: FakeSession = {
      id: `sess_fake_${randomUUID()}`,
      model: 'fake-model',
      turns: [],
      messageCount: 0,
    };
    this.sessions.set(session.id, session);
    this.logger.log(`Fake session created for user ${meta.userHash}`);
    this.startTurn(session, input);
    return Promise.resolve({ sessionId: session.id });
  }

  async awaitCurrentTurn(sessionId: string, timeoutMs: number): Promise<TurnOutcome> {
    const session = this.requireSession(sessionId);
    const turn = session.turns.at(-1);
    if (!turn) {
      return { state: 'running', sessionId, turnId: null };
    }
    return this.waitFor(session, turn, timeoutMs);
  }

  async sendMessage(sessionId: string, input: string, timeoutMs: number): Promise<TurnOutcome> {
    const session = this.requireSession(sessionId);
    const turn = this.startTurn(session, input);
    return this.waitFor(session, turn, timeoutMs);
  }

  getTurnOutcome(sessionId: string, turnId: string | null): Promise<TurnOutcome> {
    const session = this.requireSession(sessionId);
    const turn = turnId ? session.turns.find((t) => t.id === turnId) : session.turns.at(-1);
    if (!turn) {
      return Promise.resolve({ state: 'running', sessionId, turnId });
    }
    return Promise.resolve(this.outcomeOf(session, turn));
  }

  getSessionState(sessionId: string): Promise<SessionState> {
    const session = this.requireSession(sessionId);
    const turn = session.turns.at(-1);
    const elapsed = turn ? Date.now() >= turn.completesAt : false;
    const requiresAction = turn?.requiresAction === true && elapsed;
    const running = turn ? !elapsed : false;

    return Promise.resolve({
      sessionId,
      status: requiresAction ? 'requires_action' : running ? 'in_progress' : 'idle',
      model: session.model,
      requiredActions: requiresAction
        ? [
            {
              type: 'function_call',
              callId: `call_${turn?.id ?? 'unknown'}`,
              name: 'unknown_local_tool',
              arguments: {},
              turnId: turn?.id ?? '',
            },
          ]
        : [],
    });
  }

  resolveRequiredActions(sessionId: string, actions: RequiredAction[]): Promise<void> {
    const session = this.requireSession(sessionId);
    const turn = session.turns.at(-1);
    if (turn) {
      // Once the tool result arrives the turn can finish, like the real API.
      turn.requiresAction = false;
      turn.completesAt = Date.now();
    }
    this.logger.log(`Fake session ${session.id} resolved ${actions.length} required action(s)`);
    return Promise.resolve();
  }

  updateModel(sessionId: string, model: string): Promise<void> {
    this.requireSession(sessionId).model = model;
    return Promise.resolve();
  }

  validateAgent(): Promise<void> {
    return Promise.resolve();
  }

  private startTurn(session: FakeSession, input: string): FakeTurn {
    session.messageCount += 1;
    const turn: FakeTurn = {
      id: `turn_fake_${randomUUID()}`,
      input,
      completesAt: Date.now() + this.envInt('FAKE_DELAY_MS', 50),
      finalState: this.envFlag('FAKE_FAIL')
        ? 'failed'
        : this.envFlag('FAKE_CANCEL')
          ? 'cancelled'
          : 'completed',
      requiresAction: this.envFlag('FAKE_REQUIRES_ACTION'),
    };
    session.turns.push(turn);
    return turn;
  }

  private async waitFor(
    session: FakeSession,
    turn: FakeTurn,
    timeoutMs: number,
  ): Promise<TurnOutcome> {
    const remaining = turn.completesAt - Date.now();
    if (remaining > timeoutMs) {
      await sleep(timeoutMs);
      return { state: 'running', sessionId: session.id, turnId: turn.id };
    }
    await sleep(remaining);
    return this.outcomeOf(session, turn);
  }

  private outcomeOf(session: FakeSession, turn: FakeTurn): TurnOutcome {
    // A turn blocked on a required action never finishes on its own.
    if (Date.now() < turn.completesAt || turn.requiresAction) {
      return { state: 'running', sessionId: session.id, turnId: turn.id };
    }

    if (turn.finalState === 'failed') {
      return { state: 'failed', sessionId: session.id, turnId: turn.id, error: 'fake failure' };
    }
    if (turn.finalState === 'cancelled') {
      return {
        state: 'cancelled',
        sessionId: session.id,
        turnId: turn.id,
        error: 'fake cancellation',
      };
    }

    const position = session.turns.indexOf(turn) + 1;
    return {
      state: 'completed',
      sessionId: session.id,
      turnId: turn.id,
      // Echoing the session position proves the conversation is durable:
      // the caller never re-sends history, yet the count keeps growing.
      text: `Фейковый ответ на «${turn.input}». Это сообщение номер ${position} в текущем разговоре.`,
      usage: {
        inputTokens: 10 * position,
        outputTokens: 20,
        totalTokens: 10 * position + 20,
        reasoningTokens: 0,
        cachedTokens: 0,
      },
      model: session.model,
    };
  }

  private requireSession(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentSessionUnavailableError(`Fake session ${sessionId} does not exist`);
    }
    return session;
  }

  private envInt(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private envFlag(name: string): boolean {
    return process.env[name] === 'true' || process.env[name] === '1';
  }
}
