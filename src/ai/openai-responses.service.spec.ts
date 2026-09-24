import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { AppConfig } from '../config/configuration.js';
import { OpenAIResponsesService } from './openai-responses.service.js';
import { AgentConfigurationError, AgentSessionUnavailableError } from './types/ai.types.js';

const CONVERSATION_ID = 'conv_1';
const RESPONSE_ID = 'resp_1';
const AGENT_ID = 'agent_1';

/** Stream of the events the Responses API emits for a finished answer. */
function answerStream(events?: unknown[]) {
  const abort = jest.fn();
  const payload = events ?? [
    { type: 'response.created', response: { id: RESPONSE_ID } },
    // The real API streams the answer as deltas; `output_text` is a helper the
    // SDK computes only for a plain (non-streamed) response.
    { type: 'response.output_text.delta', delta: 'Па' },
    { type: 'response.output_text.delta', delta: 'риж' },
    {
      type: 'response.completed',
      response: {
        id: RESPONSE_ID,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Париж' }] }],
        usage: {
          input_tokens: 120,
          output_tokens: 3,
          total_tokens: 123,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];

  return {
    controller: { abort },
    async *[Symbol.asyncIterator]() {
      for (const event of payload) {
        yield event;
      }
    },
  };
}

/** Stream that starts a web search and then stalls, like a slow lookup. */
function searchingStream() {
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    controller: { abort: jest.fn(() => release()) },
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.created', response: { id: RESPONSE_ID } };
      yield { type: 'response.web_search_call.searching' };
      await blocked;
    },
  };
}

const assistantMessage = (text: string, createdAt?: number) => ({
  type: 'message',
  role: 'assistant',
  created_at: createdAt,
  content: [{ type: 'output_text', text }],
});

describe('OpenAIResponsesService', () => {
  const config = {
    get: () => ({ agentId: AGENT_ID, apiKey: 'sk-test', requestTimeoutMs: 30_000 }),
  } as unknown as ConfigService<AppConfig, true>;

  let conversations: {
    create: ReturnType<typeof jest.fn>;
    items: { list: ReturnType<typeof jest.fn> };
  };
  let responses: { create: ReturnType<typeof jest.fn> };
  let agents: { retrieve: ReturnType<typeof jest.fn> };
  let service: OpenAIResponsesService;

  beforeEach(async () => {
    conversations = {
      create: jest.fn(async () => ({ id: CONVERSATION_ID })),
      items: { list: jest.fn(async () => ({ data: [] })) },
    };
    responses = { create: jest.fn(async () => answerStream()) };
    agents = {
      retrieve: jest.fn(async () => ({
        id: AGENT_ID,
        name: 'Alice Assistant',
        model: 'gpt-6-luna',
        instructions: 'Ты голосовой ассистент.',
        tools: [{ type: 'web_search' }, { type: 'function', name: 'local' }],
      })),
    };

    const client = { conversations, responses, beta: { agents } } as unknown as OpenAI;
    service = new OpenAIResponsesService(client, config);
    await service.validateAgent();
  });

  describe('configuration', () => {
    it('takes model, instructions and built-in tools from the saved agent', async () => {
      await service.sendMessage(CONVERSATION_ID, 'Столица Франции?', 2500);

      expect(responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-6-luna',
          instructions: 'Ты голосовой ассистент.',
          conversation: CONVERSATION_ID,
          input: 'Столица Франции?',
          // Function tools need the Responses schema shape, so only built-ins carry over.
          tools: [{ type: 'web_search' }],
          store: true,
          stream: true,
        }),
        { timeout: expect.any(Number), maxRetries: 0 },
      );
    });

    it('explains a missing agent id', async () => {
      agents.retrieve.mockRejectedValue(new OpenAI.APIError(404, undefined, 'nope', undefined));

      const fresh = new OpenAIResponsesService(
        { conversations, responses, beta: { agents } } as unknown as OpenAI,
        config,
      );
      await expect(fresh.validateAgent()).rejects.toBeInstanceOf(AgentConfigurationError);
    });
  });

  describe('startConversation', () => {
    it('creates the conversation and persists its id before answering', async () => {
      const persisted: string[] = [];

      const outcome = await service.startConversation(
        'Привет',
        { userHash: 'abc' },
        2500,
        async (id) => {
          persisted.push(id);
        },
      );

      expect(conversations.create).toHaveBeenCalledWith(
        { metadata: { alice_user: 'abc' } },
        { timeout: expect.any(Number), maxRetries: 0 },
      );
      expect(persisted).toEqual([CONVERSATION_ID]);
      expect(outcome).toMatchObject({ state: 'completed', text: 'Париж' });
    });
  });

  describe('answering', () => {
    it('returns the answer with usage on the direct path', async () => {
      const outcome = await service.sendMessage(CONVERSATION_ID, 'Вопрос', 2500);

      expect(outcome).toMatchObject({
        state: 'completed',
        turnId: RESPONSE_ID,
        text: 'Париж',
        model: 'gpt-6-luna',
        usage: { inputTokens: 120, outputTokens: 3, cachedTokens: 100 },
      });
    });

    it('defers instead of failing when the budget runs out', async () => {
      // Verified against the live API: the answer is still appended to the
      // conversation after we stop waiting, so this is a deferral, not a loss.
      responses.create.mockResolvedValue(searchingStream());

      const outcome = await service.sendMessage(CONVERSATION_ID, 'Вопрос', 50);

      expect(outcome).toMatchObject({
        state: 'running',
        sessionId: CONVERSATION_ID,
        turnId: RESPONSE_ID,
      });
    });

    it('reports that a web search is what is taking the time', async () => {
      // A search costs about three seconds on its own — measured on production.
      // Saying so explains the wait instead of leaving the user guessing.
      responses.create.mockResolvedValue(searchingStream());

      const outcome = await service.sendMessage(CONVERSATION_ID, 'Что нового?', 50);

      expect(outcome).toMatchObject({ state: 'running', searching: true });
    });

    it('does not claim a search when none happened', async () => {
      responses.create.mockResolvedValue({
        controller: { abort: jest.fn() },

        async *[Symbol.asyncIterator]() {
          yield { type: 'response.created', response: { id: RESPONSE_ID } };
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
      });

      const outcome = await service.sendMessage(CONVERSATION_ID, 'Вопрос', 50);

      expect(outcome).toMatchObject({ state: 'running', searching: false });
    });
  });

  describe('conversations from another provider', () => {
    it('reports an Agents session id as unavailable so a fresh one is opened', async () => {
      // Switching AI_PROVIDER leaves `sess_…` ids in Postgres; the API answers
      // them with a 400, which used to surface as "не получилось получить ответ".
      await expect(service.sendMessage('sess_old_123', 'Вопрос', 2500)).rejects.toBeInstanceOf(
        AgentSessionUnavailableError,
      );
      expect(responses.create).not.toHaveBeenCalled();
    });

    it('does the same when reading a deferred answer', async () => {
      await expect(service.getTurnOutcome('sess_old_123', null)).rejects.toBeInstanceOf(
        AgentSessionUnavailableError,
      );
    });
  });

  describe('picking up a deferred answer', () => {
    it('reads the answer from the conversation', async () => {
      conversations.items.list.mockResolvedValue({
        data: [assistantMessage('Готовый ответ', 1_800_000_010)],
      });

      const outcome = await service.getTurnOutcome(CONVERSATION_ID, null, 1_800_000_000_000);

      expect(outcome).toMatchObject({ state: 'completed', text: 'Готовый ответ' });
    });

    it('ignores an answer older than the question', async () => {
      // Replaying the previous answer would be worse than saying "still thinking".
      conversations.items.list.mockResolvedValue({
        data: [assistantMessage('Прошлый ответ', 1_799_990_000)],
      });

      const outcome = await service.getTurnOutcome(CONVERSATION_ID, null, 1_800_000_000_000);

      expect(outcome.state).toBe('running');
    });

    it('reports running while nothing has been written yet', async () => {
      const outcome = await service.getTurnOutcome(CONVERSATION_ID, null, Date.now());
      expect(outcome.state).toBe('running');
    });
  });
});
