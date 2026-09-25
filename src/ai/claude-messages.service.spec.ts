// In ESM mode Jest does not expose `jest` as a global — it must be imported.
import Anthropic from '@anthropic-ai/sdk';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import type {
  ConversationHistoryService,
  HistoryMessage,
  StoredAnswer,
} from '../conversations/conversation-history.service.js';
import { ClaudeMessagesService } from './claude-messages.service.js';
import { ConversationUnavailableError, ProviderConfigurationError } from './types/ai.types.js';

const SESSION_ID = 'claude_11111111-2222-3333-4444-555555555555';
const TURN_ID = 'msg_01ABC';
const MODEL_FAST = 'claude-haiku-4-5-20251001';

const usage = {
  input_tokens: 120,
  output_tokens: 40,
  cache_read_input_tokens: 100,
  output_tokens_details: { thinking_tokens: 7 },
};

const finalMessage = (text = 'Готовый ответ') => ({
  id: TURN_ID,
  model: MODEL_FAST,
  content: [{ type: 'text', text }],
  usage,
});

/**
 * Mimics `MessageStream`: async-iterable over raw events plus `finalMessage()`.
 * `hold` lets a test keep the stream open past the deadline on purpose.
 */
const stream = (events: unknown[], hold?: Promise<void>) => {
  const final = finalMessage();
  return {
    controller: { abort: jest.fn() },
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event as never;
      }
      if (hold) {
        await hold;
      }
    },
    finalMessage: async () => {
      if (hold) {
        await hold;
      }
      return final as never;
    },
  };
};

const answerEvents = (text = 'Готовый ответ') => [
  { type: 'message_start', message: { id: TURN_ID } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text } },
];

const searchEvents = () => [
  { type: 'message_start', message: { id: TURN_ID } },
  { type: 'content_block_start', content_block: { type: 'server_tool_use', name: 'web_search' } },
];

describe('ClaudeMessagesService', () => {
  let service: ClaudeMessagesService;
  let messages: { stream: jest.Mock<(...args: never[]) => unknown> };
  let models: { retrieve: jest.Mock<(model: string) => Promise<{ id: string }>> };
  let history: jest.Mocked<ConversationHistoryService>;

  const config = {
    get: () => ({
      anthropic: {
        apiKey: 'sk-ant-test',
        modelFast: MODEL_FAST,
        modelSmart: 'claude-sonnet-5',
        maxTokens: 1024,
        webSearch: true,
        historyMessages: 20,
        requestTimeoutMs: 30_000,
      },
    }),
  } as unknown as ConfigService<AppConfig, true>;

  beforeEach(() => {
    messages = { stream: jest.fn(() => stream(answerEvents())) };
    models = { retrieve: jest.fn(async (_model: string) => ({ id: MODEL_FAST })) };

    history = {
      recentMessages: jest.fn(async (): Promise<HistoryMessage[]> => []),
      appendUserMessage: jest.fn(async () => undefined),
      appendAssistantMessage: jest.fn(async () => undefined),
      findAnswer: jest.fn(async (): Promise<StoredAnswer | null> => null),
      findConversationModel: jest.fn(async (): Promise<string | null> => null),
    } as unknown as jest.Mocked<ConversationHistoryService>;

    service = new ClaudeMessagesService(
      { messages, models } as unknown as Anthropic,
      history,
      config,
      'Ты голосовой ассистент.',
    );
  });

  describe('starting a conversation', () => {
    it('persists the conversation id before answering', async () => {
      const created: string[] = [];

      const outcome = await service.startConversation(
        'Что приготовить',
        { userHash: 'hash' },
        3_000,
        async (sessionId) => {
          created.push(sessionId);
        },
      );

      // Without the row there is nowhere to store the history, so the id must
      // be handed over before any answer can arrive.
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^claude_/);
      expect(outcome.state).toBe('completed');
    });

    it('reports usage and model from the finished message', async () => {
      const outcome = await service.startConversation(
        'Вопрос',
        { userHash: 'hash' },
        3_000,
        async () => undefined,
      );

      expect(outcome).toMatchObject({
        state: 'completed',
        text: 'Готовый ответ',
        model: MODEL_FAST,
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          totalTokens: 160,
          reasoningTokens: 7,
          cachedTokens: 100,
        },
      });
    });
  });

  describe('continuing a conversation', () => {
    it('resends the stored history, because the API remembers nothing', async () => {
      history.recentMessages.mockResolvedValue([
        { role: 'user', content: 'Первый вопрос' },
        { role: 'assistant', content: 'Первый ответ' },
      ]);

      await service.sendMessage(SESSION_ID, 'Второй вопрос', 3_000);

      const [params] = messages.stream.mock.calls[0] as unknown as [{ messages: unknown[] }];
      expect(params.messages).toEqual([
        { role: 'user', content: 'Первый вопрос' },
        { role: 'assistant', content: 'Первый ответ' },
        { role: 'user', content: 'Второй вопрос' },
      ]);
    });

    it('stores the question even before the answer exists', async () => {
      await service.sendMessage(SESSION_ID, 'Второй вопрос', 3_000);

      // A lost answer must not also lose the question, or the next reply would
      // be answering a blank.
      expect(history.appendUserMessage).toHaveBeenCalledWith(SESSION_ID, 'Второй вопрос');
    });

    it('rejects a conversation created by another provider', async () => {
      await expect(service.sendMessage('conv_openai_1', 'Вопрос', 3_000)).rejects.toBeInstanceOf(
        ConversationUnavailableError,
      );
    });
  });

  describe('running out of budget', () => {
    it('keeps reading the stream and stores the answer afterwards', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      messages.stream.mockReturnValue(stream(answerEvents(), held));

      const outcome = await service.sendMessage(SESSION_ID, 'Долгий вопрос', 50);

      expect(outcome).toMatchObject({ state: 'running', turnId: TURN_ID });
      // Aborting here would destroy the only copy of the answer.
      expect(history.appendAssistantMessage).not.toHaveBeenCalled();

      release();
      await new Promise((resolve) => setImmediate(resolve));

      expect(history.appendAssistantMessage).toHaveBeenCalledWith(
        SESSION_ID,
        TURN_ID,
        expect.objectContaining({ text: 'Готовый ответ', model: MODEL_FAST }),
      );
    });

    it('says it is searching the web, which explains the wait', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      messages.stream.mockReturnValue(stream(searchEvents(), held));

      const outcome = await service.sendMessage(SESSION_ID, 'Какая погода', 50);

      expect(outcome).toMatchObject({ state: 'running', searching: true });
      release();
    });
  });

  describe('collecting a deferred answer', () => {
    it('returns the stored answer with its usage', async () => {
      history.findAnswer.mockResolvedValue({
        text: 'Готовый ответ',
        model: MODEL_FAST,
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          totalTokens: 160,
          reasoningTokens: 7,
          cachedTokens: 100,
        },
      });

      const outcome = await service.getTurnOutcome(SESSION_ID, TURN_ID);

      expect(outcome).toMatchObject({ state: 'completed', text: 'Готовый ответ' });
    });

    it('reports a failure when the answer died with the process', async () => {
      // Nothing stored and nothing in flight: a restart happened mid-generation
      // and a stateless API has no copy. Saying so beats waiting forever.
      const outcome = await service.getTurnOutcome(SESSION_ID, 'msg_lost');

      expect(outcome.state).toBe('failed');
    });

    it('waits when the turn id is not known yet', async () => {
      const outcome = await service.getTurnOutcome(SESSION_ID, null);

      expect(outcome.state).toBe('running');
    });
  });

  describe('configuration', () => {
    it('accepts a model the account can use', async () => {
      await expect(service.validateConfiguration()).resolves.toBeUndefined();
      expect(models.retrieve).toHaveBeenCalledWith(MODEL_FAST);
    });

    it('names the offending variable when the model is unknown', async () => {
      models.retrieve.mockImplementation(() =>
        Promise.reject(new Anthropic.APIError(404, undefined, 'not found', undefined)),
      );

      await expect(service.validateConfiguration()).rejects.toBeInstanceOf(
        ProviderConfigurationError,
      );
    });

    it('offers both model profiles for voice switching', () => {
      expect(service.modelProfiles()).toEqual({
        fast: MODEL_FAST,
        smart: 'claude-sonnet-5',
      });
    });
  });
});
