import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { AppConfig } from '../config/configuration.js';
import { OpenAIResponsesService } from './openai-responses.service.js';
import { ProviderConfigurationError, ConversationUnavailableError } from './types/ai.types.js';

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

describe('OpenAIResponsesService', () => {
  const config = {
    // The services read config.get('ai').openai, so the stub mirrors that shape.
    get: () => ({
      openai: { agentId: AGENT_ID, apiKey: 'sk-test', requestTimeoutMs: 30_000 },
    }),
  } as unknown as ConfigService<AppConfig, true>;

  let conversations: { create: ReturnType<typeof jest.fn> };
  let responses: {
    create: ReturnType<typeof jest.fn>;
    retrieve: ReturnType<typeof jest.fn>;
  };
  let agents: { retrieve: ReturnType<typeof jest.fn> };
  let service: OpenAIResponsesService;

  beforeEach(async () => {
    conversations = { create: jest.fn(async () => ({ id: CONVERSATION_ID })) };
    responses = {
      create: jest.fn(async () => answerStream()),
      retrieve: jest.fn(async () => ({ id: RESPONSE_ID, status: 'in_progress' })),
    };
    agents = {
      retrieve: jest.fn(async () => ({
        id: AGENT_ID,
        name: 'Alice Assistant',
        model: 'gpt-6-luna',
        instructions: 'Ты голосовой ассистент.',
        tools: [{ type: 'web_search' }, { type: 'function', name: 'local' }],
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
      })),
    };

    const client = { conversations, responses, beta: { agents } } as unknown as OpenAI;
    service = new OpenAIResponsesService(client, config);
    await service.validateConfiguration();
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
          // Latency, not style: the agent's own reasoning level answers twice
          // as fast as the model default (2,0 с против 4,3 с на проде).
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' },
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
      await expect(fresh.validateConfiguration()).rejects.toBeInstanceOf(ProviderConfigurationError);
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
      // The answer keeps being written after we stop waiting, so this is a
      // deferral, not a loss.
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

  describe('running out of budget', () => {
    it('keeps the connection open so the question is not lost', async () => {
      // Verified on the live API: aborting the stream discards the exchange —
      // the question never reaches the conversation and the response id turns
      // into a 404, which left the skill saying "я ещё думаю" forever.
      let released: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        released = resolve;
      });
      const abort = jest.fn();

      responses.create.mockResolvedValue({
        controller: { abort },
        async *[Symbol.asyncIterator]() {
          yield { type: 'response.created', response: { id: RESPONSE_ID } };
          yield { type: 'response.web_search_call.searching' };
          await blocked;
          yield {
            type: 'response.completed',
            response: { id: RESPONSE_ID, output: [], usage: null },
          };
        },
      });

      const outcome = await service.sendMessage(CONVERSATION_ID, 'Долгий вопрос', 50);

      expect(outcome).toMatchObject({
        state: 'running',
        turnId: RESPONSE_ID,
        searching: true,
      });
      expect(abort).not.toHaveBeenCalled();

      // The reading keeps going and completes on its own.
      released();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('conversations from another provider', () => {
    it('reports an Agents session id as unavailable so a fresh one is opened', async () => {
      // Switching AI_PROVIDER leaves `sess_…` ids in Postgres; the API answers
      // them with a 400, which used to surface as "не получилось получить ответ".
      await expect(service.sendMessage('sess_old_123', 'Вопрос', 2500)).rejects.toBeInstanceOf(
        ConversationUnavailableError,
      );
      expect(responses.create).not.toHaveBeenCalled();
    });

    it('does the same when reading a deferred answer', async () => {
      await expect(service.getTurnOutcome('sess_old_123', null)).rejects.toBeInstanceOf(
        ConversationUnavailableError,
      );
    });
  });

  describe('picking up a deferred answer', () => {
    it('reads the exact response by its id', async () => {
      responses.retrieve = jest.fn(async () => ({
        id: RESPONSE_ID,
        status: 'completed',
        output_text: 'Готовый ответ',
        model: 'gpt-6-luna',
      }));

      const outcome = await service.getTurnOutcome(CONVERSATION_ID, RESPONSE_ID);

      expect(outcome).toMatchObject({ state: 'completed', text: 'Готовый ответ' });
    });

    it('reports a response that is still being written as running', async () => {
      responses.retrieve = jest.fn(async () => ({ id: RESPONSE_ID, status: 'in_progress' }));

      const outcome = await service.getTurnOutcome(CONVERSATION_ID, RESPONSE_ID);
      expect(outcome.state).toBe('running');
    });

    it('never replays an older answer when the response id is unknown', async () => {
      // Conversation items carry no timestamps, so the previous answer is
      // indistinguishable from the awaited one — this used to make the skill
      // repeat itself.
      const outcome = await service.getTurnOutcome(CONVERSATION_ID, null);

      expect(outcome).toEqual({ state: 'running', sessionId: CONVERSATION_ID, turnId: null });
    });
  });
});
