import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AgentSessionEvent } from 'openai/resources/beta/agents/agents';

import type { AppConfig } from '../config/configuration.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { OpenAIAgentsService } from './openai-agents.service.js';
import { AgentConfigurationError, AgentSessionUnavailableError } from './types/ai.types.js';

const SESSION_ID = 'sess_1';
const TURN_ID = 'turn_1';
const AGENT_ID = 'agent_1';

/** A stream that yields the given events and then ends, like a finished turn. */
function eventStream(events: AgentSessionEvent[]) {
  const abort = jest.fn();
  return {
    abort,
    controller: { abort },
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** A stream that never produces a terminal event until it is aborted. */
function hangingStream() {
  let release: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abort = jest.fn(() => release());

  return {
    abort,
    controller: { abort },
    async *[Symbol.asyncIterator]() {
      yield turnCreated();
      await aborted;
      // Mirrors the SDK: aborting closes the local request and iteration ends.
    },
  };
}

const turnCreated = (): AgentSessionEvent =>
  ({
    type: 'agent.session.turn.created',
    event_id: 'e1',
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    turn: { id: TURN_ID, status: 'in_progress' },
  }) as unknown as AgentSessionEvent;

const finalAnswerItem = (text: string): AgentSessionEvent =>
  ({
    type: 'agent.session.turn.item.done',
    event_id: 'e2',
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    output_index: 0,
    item: {
      type: 'message',
      id: 'item_1',
      role: 'assistant',
      phase: 'final_answer',
      status: 'completed',
      turn_id: TURN_ID,
      content: [{ type: 'output_text', text }],
    },
  }) as unknown as AgentSessionEvent;

const turnCompleted = (): AgentSessionEvent =>
  ({
    type: 'agent.session.turn.completed',
    event_id: 'e3',
    session_id: SESSION_ID,
    turn_id: TURN_ID,
    turn: {
      id: TURN_ID,
      status: 'completed',
      usage: {
        input_tokens: 100,
        output_tokens: 42,
        total_tokens: 142,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    },
    usage: {
      input_tokens: 100,
      output_tokens: 42,
      total_tokens: 142,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 7 },
    },
  }) as unknown as AgentSessionEvent;

const requiresAction = (): AgentSessionEvent =>
  ({
    type: 'agent.session.requires_action',
    event_id: 'e4',
    session: {
      id: SESSION_ID,
      status: 'requires_action',
      agent: { model: 'gpt-6-luna' },
      required_actions: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'unknown_tool',
          arguments: { city: 'Москва' },
          turn_id: TURN_ID,
        },
      ],
    },
  }) as unknown as AgentSessionEvent;

describe('OpenAIAgentsService', () => {
  const config = {
    get: () => ({ agentId: AGENT_ID, apiKey: 'sk-test', requestTimeoutMs: 30_000 }),
  } as unknown as ConfigService<AppConfig, true>;

  let client: {
    beta: {
      agents: {
        retrieve: ReturnType<typeof jest.fn>;
        sessions: Record<string, unknown>;
      };
    };
  };
  let sessions: {
    create: ReturnType<typeof jest.fn>;
    retrieve: ReturnType<typeof jest.fn>;
    update: ReturnType<typeof jest.fn>;
    stream: ReturnType<typeof jest.fn>;
    events: { create: ReturnType<typeof jest.fn>; stream: ReturnType<typeof jest.fn> };
    turns: { retrieve: ReturnType<typeof jest.fn>; list: ReturnType<typeof jest.fn> };
    items: { list: ReturnType<typeof jest.fn> };
  };
  let tools: ToolRegistryService;
  let service: OpenAIAgentsService;

  beforeEach(() => {
    sessions = {
      create: jest.fn(async () => ({ id: SESSION_ID })),
      retrieve: jest.fn(async () => ({
        id: SESSION_ID,
        status: 'idle',
        agent: { model: 'gpt-6-luna' },
        required_actions: [],
      })),
      update: jest.fn(async () => ({ id: SESSION_ID })),
      stream: jest.fn(() =>
        eventStream([turnCreated(), finalAnswerItem('Ответ'), turnCompleted()]),
      ),
      events: {
        create: jest.fn(async () => undefined),
        stream: jest.fn(async () =>
          eventStream([turnCreated(), finalAnswerItem('Ответ'), turnCompleted()]),
        ),
      },
      turns: {
        retrieve: jest.fn(async () => ({ id: TURN_ID, status: 'completed', usage: null })),
        list: jest.fn(async () => ({ data: [{ id: TURN_ID, status: 'completed', usage: null }] })),
      },
      items: { list: jest.fn(async () => ({ data: [] })) },
    };

    client = { beta: { agents: { retrieve: jest.fn(async () => ({ id: AGENT_ID })), sessions } } };
    tools = new ToolRegistryService();
    service = new OpenAIAgentsService(client as unknown as OpenAI, config, tools);
  });

  describe('startConversation', () => {
    const sessionCreated = (): AgentSessionEvent =>
      ({
        type: 'agent.session.created',
        event_id: 'e0',
        session: { id: SESSION_ID, status: 'in_progress' },
      }) as unknown as AgentSessionEvent;

    beforeEach(() => {
      sessions.create.mockResolvedValue(
        eventStream([sessionCreated(), turnCreated(), finalAnswerItem('Ответ'), turnCompleted()]),
      );
    });

    it('creates the session and waits for the answer on one streamed request', async () => {
      const persisted: string[] = [];
      const outcome = await service.startConversation(
        'Привет',
        { userHash: 'abc123' },
        3200,
        async (id) => {
          persisted.push(id);
        },
      );

      expect(sessions.create).toHaveBeenCalledWith({
        agent_id: AGENT_ID,
        environment: { type: 'none' },
        input: 'Привет',
        metadata: { alice_user: 'abc123' },
        stream: true,
      });
      // A separate subscribe call would cost another round-trip to OpenAI.
      expect(sessions.events.stream).not.toHaveBeenCalled();
      expect(persisted).toEqual([SESSION_ID]);
      expect(outcome).toMatchObject({ state: 'completed', text: 'Ответ' });
    });

    it('persists the session id even when the deadline expires first', async () => {
      // The whole point: a turn we stop waiting for must still be reachable.
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stream = {
        controller: { abort: jest.fn(() => release()) },
        async *[Symbol.asyncIterator]() {
          yield sessionCreated();
          await blocked;
        },
      };
      sessions.create.mockResolvedValue(stream);

      const persisted: string[] = [];
      const outcome = await service.startConversation(
        'Долгий вопрос',
        { userHash: 'abc' },
        50,
        async (id) => {
          persisted.push(id);
        },
      );

      expect(persisted).toEqual([SESSION_ID]);
      expect(outcome).toMatchObject({ state: 'running', sessionId: SESSION_ID });
      // Only our connection is closed; nothing cancels the turn.
      expect(sessions.events.create).not.toHaveBeenCalled();
    });

    it('still persists the session when creating it already used up the budget', async () => {
      // A slow create must not push the total past Alice's limit: the wait that
      // follows gets whatever is left, which may be nothing at all.
      sessions.create.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return eventStream([sessionCreated(), turnCreated()]);
      });

      const persisted: string[] = [];
      const outcome = await service.startConversation(
        'Вопрос',
        { userHash: 'abc' },
        40,
        async (id) => {
          persisted.push(id);
        },
      );

      expect(persisted).toEqual([SESSION_ID]);
      expect(outcome.sessionId).toBe(SESSION_ID);
    });

    it('maps a 404 to a session-unavailable error so the caller can recover', async () => {
      sessions.create.mockRejectedValue(
        new OpenAI.APIError(404, undefined, 'not found', undefined),
      );

      await expect(
        service.startConversation('Привет', { userHash: 'a' }, 3200, async () => undefined),
      ).rejects.toBeInstanceOf(AgentSessionUnavailableError);
    });
  });

  describe('sendMessage', () => {
    it('returns the final answer with usage when the turn completes', async () => {
      const outcome = await service.sendMessage(SESSION_ID, 'Вопрос', 3200);

      expect(sessions.stream).toHaveBeenCalledWith(SESSION_ID, {
        input: 'Вопрос',
        toolHandlers: {},
      });
      expect(outcome).toMatchObject({
        state: 'completed',
        turnId: TURN_ID,
        text: 'Ответ',
        usage: { inputTokens: 100, outputTokens: 42, reasoningTokens: 7, cachedTokens: 10 },
      });
    });

    it('stops waiting at the soft timeout without cancelling the turn', async () => {
      const stream = hangingStream();
      sessions.stream.mockReturnValue(stream);

      const outcome = await service.sendMessage(SESSION_ID, 'Долгий вопрос', 50);

      expect(outcome).toEqual({ state: 'running', sessionId: SESSION_ID, turnId: TURN_ID });
      // Local iteration is closed…
      expect(stream.abort).toHaveBeenCalled();
      // …but nothing cancels the turn on OpenAI's side.
      expect(sessions.events.create).not.toHaveBeenCalled();
    });

    it('checks the turn when the session goes idle instead of trusting the event', async () => {
      // "An idle session alone does not mean the turn succeeded": an idle event
      // must send us to the saved state, not be treated as success or failure.
      const idle = {
        type: 'agent.session.idle',
        event_id: 'e5',
        session: { id: SESSION_ID, status: 'idle' },
      } as unknown as AgentSessionEvent;
      sessions.stream.mockReturnValue(eventStream([turnCreated(), idle]));
      sessions.items.list.mockResolvedValue({
        data: [
          {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            turn_id: TURN_ID,
            content: [{ type: 'output_text', text: 'Ответ из items' }],
          },
        ],
      });

      const outcome = await service.sendMessage(SESSION_ID, 'Вопрос', 3200);

      expect(sessions.turns.retrieve).toHaveBeenCalled();
      expect(outcome).toMatchObject({ state: 'completed', text: 'Ответ из items' });
    });

    it('answers required actions for unknown tools instead of leaving the session blocked', async () => {
      sessions.stream.mockReturnValue(
        eventStream([turnCreated(), requiresAction(), finalAnswerItem('Ответ'), turnCompleted()]),
      );

      await service.sendMessage(SESSION_ID, 'Вопрос', 3200);

      expect(sessions.events.create).toHaveBeenCalledWith(SESSION_ID, {
        events: [
          {
            type: 'agent.session.input.tool_result',
            call_id: 'call_1',
            turn_id: TURN_ID,
            success: false,
            error: 'Tool "unknown_tool" is not available',
          },
        ],
      });
    });

    it('runs a registered tool and reports its result', async () => {
      tools.register({
        name: 'unknown_tool',
        description: 'test tool',
        handler: () => ({ temperature: -5 }),
      });
      sessions.stream.mockReturnValue(
        eventStream([turnCreated(), requiresAction(), turnCompleted()]),
      );

      await service.sendMessage(SESSION_ID, 'Вопрос', 3200);

      expect(sessions.events.create).toHaveBeenCalledWith(SESSION_ID, {
        events: [
          expect.objectContaining({ success: true, output: JSON.stringify({ temperature: -5 }) }),
        ],
      });
    });
  });

  describe('getTurnOutcome', () => {
    it('recovers a finished answer from saved items after a disconnect', async () => {
      sessions.items.list.mockResolvedValue({
        data: [
          {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            turn_id: TURN_ID,
            content: [{ type: 'output_text', text: 'Думаю…' }],
          },
          {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            turn_id: TURN_ID,
            content: [{ type: 'output_text', text: 'Готовый ответ' }],
          },
        ],
      });

      const outcome = await service.getTurnOutcome(SESSION_ID, TURN_ID);

      expect(sessions.turns.retrieve).toHaveBeenCalledWith(TURN_ID, { session_id: SESSION_ID });
      expect(outcome).toMatchObject({ state: 'completed', text: 'Готовый ответ' });
    });

    it('reports a still-running turn as running, not as a failure', async () => {
      sessions.turns.retrieve.mockResolvedValue({
        id: TURN_ID,
        status: 'in_progress',
        usage: null,
      });

      const outcome = await service.getTurnOutcome(SESSION_ID, TURN_ID);
      expect(outcome.state).toBe('running');
    });

    it.each([
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
    ])('maps a %s turn', async (status, expected) => {
      sessions.turns.retrieve.mockResolvedValue({
        id: TURN_ID,
        status,
        usage: null,
        error: { code: 'server_error', message: 'boom' },
      });

      const outcome = await service.getTurnOutcome(SESSION_ID, TURN_ID);
      expect(outcome.state).toBe(expected);
    });

    it('looks through recent turns when the turn id is unknown', async () => {
      await service.getTurnOutcome(SESSION_ID, null);
      expect(sessions.turns.list).toHaveBeenCalledWith(SESSION_ID, { limit: 10, order: 'desc' });
    });

    it('ignores turns that started before the question we are waiting for', async () => {
      // The Agents API can take seconds to create a turn, so a pending answer
      // often has no id. Time is then the only way to tell turns apart — and
      // replaying an older answer would be worse than saying "still thinking".
      const startedAt = 1_800_000_000_000;
      sessions.turns.list.mockResolvedValue({
        data: [{ id: 'turn_old', status: 'completed', usage: null, created_at: 1_799_999_000 }],
      });

      const outcome = await service.getTurnOutcome(SESSION_ID, null, startedAt);
      expect(outcome.state).toBe('running');
    });

    it('accepts the turn that started with the question', async () => {
      const startedAt = 1_800_000_000_000;
      sessions.turns.list.mockResolvedValue({
        data: [{ id: 'turn_new', status: 'completed', usage: null, created_at: 1_800_000_005 }],
      });

      const outcome = await service.getTurnOutcome(SESSION_ID, null, startedAt);
      expect(outcome).toMatchObject({ state: 'completed', turnId: 'turn_new' });
    });
  });

  describe('model switching', () => {
    it('updates the session model for subsequent turns', async () => {
      await service.updateModel(SESSION_ID, 'gpt-6-sol');
      expect(sessions.update).toHaveBeenCalledWith(SESSION_ID, { agent: { model: 'gpt-6-sol' } });
    });
  });

  describe('validateAgent', () => {
    it('passes for a known agent', async () => {
      await expect(service.validateAgent()).resolves.toBeUndefined();
      expect(client.beta.agents.retrieve).toHaveBeenCalledWith(AGENT_ID);
    });

    it('explains a missing OPENAI_AGENT_ID', async () => {
      client.beta.agents.retrieve.mockRejectedValue(
        new OpenAI.APIError(404, undefined, 'not found', undefined),
      );

      await expect(service.validateAgent()).rejects.toBeInstanceOf(AgentConfigurationError);
    });

    it('explains missing Agents API permissions', async () => {
      client.beta.agents.retrieve.mockRejectedValue(
        new OpenAI.APIError(403, undefined, 'forbidden', undefined),
      );

      await expect(service.validateAgent()).rejects.toThrow(/api\.agents\.read/);
    });
  });
});
