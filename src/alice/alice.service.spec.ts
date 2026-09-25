// In ESM mode Jest does not expose `jest` as a global — it must be imported.
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import { AiConversationProvider } from '../ai/ai-conversation.provider.js';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import {
  ConversationUnavailableError,
  ProviderConfigurationError,
  type ConversationMeta,
  type SessionState,
  type TurnOutcome,
} from '../ai/types/ai.types.js';
import type { AppConfig } from '../config/configuration.js';
import { AiProvider } from '../config/env.validation.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import type { ConversationEntity } from '../conversations/entities/conversation.entity.js';
import { MemoryService } from '../memory/memory.service.js';
import { NoopMemoryService } from '../memory/noop-memory.service.js';
import { PendingService } from '../pending/pending.service.js';
import { SpeechService } from '../speech/speech.service.js';
import { UsageService } from '../usage/usage.service.js';
import { AliceService } from './alice.service.js';
import type { AliceWebhookDto } from './dto/alice-request.dto.js';
import { PHRASES } from './phrases.js';
import { AliceResponseService } from './services/alice-response.service.js';
import { CommandParserService } from './services/command-parser.service.js';

const SESSION_ID = 'sess_test_1';
const CONVERSATION_ID = 'conv-1';
const USER_ID = 'user-1';

const conversation = (
  overrides: Partial<ConversationEntity> = {},
): ConversationEntity =>
  ({
    id: CONVERSATION_ID,
    userId: USER_ID,
    provider: AiProvider.Responses,
    providerSessionId: SESSION_ID,
    model: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ConversationEntity;

const request = (command: string, extra: Partial<AliceWebhookDto> = {}): AliceWebhookDto => {
  const { session, ...rest } = extra;
  return {
    version: '1.0',
    session: {
      session_id: 'sess-alice',
      skill_id: 'skill-1',
      application: { application_id: 'app-123' },
      new: false,
      ...(session ?? {}),
    },
    request: { type: 'SimpleUtterance', command, original_utterance: command },
    ...rest,
  };
};

const completed = (text = 'Ответ модели'): TurnOutcome => ({
  state: 'completed',
  sessionId: SESSION_ID,
  turnId: 'turn-1',
  text,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 0, cachedTokens: 0 },
  model: 'gpt-6-luna',
});

const running = (): TurnOutcome => ({
  state: 'running',
  sessionId: SESSION_ID,
  turnId: 'turn-1',
});

const idleState = (): SessionState => ({
  sessionId: SESSION_ID,
  status: 'idle',
  model: 'gpt-6-luna',
  requiredActions: [],
});

describe('AliceService', () => {
  let ai: jest.Mocked<AiConversationProvider>;
  let claude: jest.Mocked<AiConversationProvider>;
  let registry: AiProviderRegistry;
  let conversations: jest.Mocked<ConversationsService>;
  let pending: jest.Mocked<PendingService>;
  let usage: jest.Mocked<UsageService>;
  let memory: MemoryService;
  let service: AliceService;

  const config = {
    get: () => ({
      softTimeoutMs: 3200,
      maxVoiceResponseChars: 900,
      activationNames: ['дядя робот'],
    }),
  } as unknown as ConfigService<AppConfig, true>;

  beforeEach(() => {
    ai = {
      startConversation: jest.fn(async (_input, _meta, _timeout, onCreated) => {
        await onCreated(SESSION_ID);
        return completed();
      }),
      sendMessage: jest.fn(async () => completed()),
      getTurnOutcome: jest.fn(async () => completed()),
      getSessionState: jest.fn(async () => idleState()),
      resolveRequiredActions: jest.fn(async () => undefined),
      updateModel: jest.fn(async () => undefined),
      validateConfiguration: jest.fn(async () => undefined),
      modelProfiles: jest.fn(() => ({ fast: 'gpt-6-luna', smart: 'gpt-6-sol' })),
      name: AiProvider.Responses,
    };

    // AliceService depends on the registry, not on one provider. A second one
    // is registered so switching has somewhere to switch to.
    claude = {
      ...ai,
      name: AiProvider.Claude,
      sendMessage: jest.fn(async () => completed('Ответ Клода')),
      startConversation: jest.fn(
        async (
          _input: string,
          _meta: ConversationMeta,
          _timeout: number,
          onCreated: (sessionId: string) => Promise<void>,
        ) => {
          await onCreated('claude_session');
          return completed('Ответ Клода');
        },
      ),
    };

    registry = new AiProviderRegistry(
      new Map([
        [AiProvider.Responses, ai],
        [AiProvider.Claude, claude],
      ]),
      AiProvider.Responses,
    );

    conversations = {
      getOrCreateUser: jest.fn(async () => ({ id: USER_ID })),
      getActiveConversation: jest.fn(async () => null),
      startConversation: jest.fn(async () => conversation()),
      archiveConversation: jest.fn(async () => undefined),
      setModel: jest.fn(async () => undefined),
      touch: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<ConversationsService>;

    pending = {
      acquireTurnLock: jest.fn(async () => 'lock-token'),
      releaseTurnLock: jest.fn(async () => undefined),
      setPending: jest.fn(async () => undefined),
      getPending: jest.fn(async () => null),
      clearPending: jest.fn(async () => undefined),
      setModelProfile: jest.fn(async () => undefined),
      getModelProfile: jest.fn(async () => null),
      setProviderPreference: jest.fn(async () => undefined),
      getProviderPreference: jest.fn(async () => null),
    } as unknown as jest.Mocked<PendingService>;

    usage = {
      recordTurn: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<UsageService>;
    memory = new NoopMemoryService();

    const responses = new AliceResponseService(
      new SpeechService({ get: () => ({ maxVoiceResponseChars: 900 }) } as unknown as ConfigService<
        AppConfig,
        true
      >),
    );

    service = new AliceService(
      registry,
      conversations,
      pending,
      usage,
      memory,
      new CommandParserService(),
      responses,
      config,
    );
  });

  describe('skill launch', () => {
    const launch = () =>
      service.handle(request('', { session: { new: true } as AliceWebhookDto['session'] }));

    it('greets without calling the model', async () => {
      const response = await launch();

      expect(response.response.text).toBe(PHRASES.greeting);
      expect(response.response.end_session).toBe(false);
      expect(response.version).toBe('1.0');
      // The greeting never goes through the model.
      expect(ai.sendMessage).not.toHaveBeenCalled();
    });

    it('answers an empty utterance mid-session without touching the model', async () => {
      const response = await service.handle(request(''));

      expect(response.response.text).toBe(PHRASES.emptyCommand);
      expect(ai.startConversation).not.toHaveBeenCalled();
    });

    it('mentions a waiting answer instead of a bare greeting', async () => {
      // The speaker went dark between sessions; without this the deferred
      // answer is invisible and the user has no reason to ask for it.
      pending.getPending.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        providerSessionId: SESSION_ID,
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
      });

      const response = await launch();

      expect(response.response.text).toBe(PHRASES.greetingWithPending);
      expect(response.session_state).toEqual({ awaitingPending: true });
    });

    it('strips the skill\'s own name from a question inside the session', async () => {
      // Yandex keeps the activation phrase in the text once the session is
      // open, so the model would be asked who "дядя робот" is.
      await service.handle(request('спроси у дяди робота что приготовить'));

      expect(ai.startConversation).toHaveBeenCalledWith(
        'что приготовить',
        expect.anything(),
        expect.any(Number),
        expect.any(Function),
      );
    });

    it('answers a question asked in the activation phrase itself', async () => {
      // «Алиса, спроси у дяди робота, что приготовить» — Dialogs strips the
      // activation phrase and delivers the rest as the command of a new
      // session. Greeting here would silently swallow the question.
      const response = await service.handle(
        request('Что приготовить из курицы', {
          session: { new: true } as AliceWebhookDto['session'],
        }),
      );

      expect(ai.startConversation).toHaveBeenCalledWith(
        'Что приготовить из курицы',
        expect.anything(),
        expect.any(Number),
        expect.any(Function),
      );
      expect(response.response.text).toBe('Ответ модели');
    });
  });

  describe('first question', () => {
    it('creates an Agent session and stores its id', async () => {
      const response = await service.handle(request('Что приготовить из курицы'));

      expect(ai.startConversation).toHaveBeenCalledWith(
        'Что приготовить из курицы',
        { userHash: expect.any(String) },
        expect.any(Number),
        expect.any(Function),
      );
      // The provider hands the id over before the answer, so it is persisted
      // even when the turn runs long — no orphan sessions.
      expect(conversations.startConversation).toHaveBeenCalledWith(
        USER_ID,
        AiProvider.Responses,
        SESSION_ID,
      );
      expect(response.response.text).toBe('Ответ модели');
    });

    it('keeps the wait inside the request budget', async () => {
      await service.handle(request('Привет'));

      const [, , budgetMs] = ai.startConversation.mock.calls[0] as [
        string,
        unknown,
        number,
        unknown,
      ];
      // The deadline counts from the arrival of the request, so it can only
      // shrink — never exceed the configured soft timeout.
      expect(budgetMs).toBeLessThanOrEqual(3200);
      expect(budgetMs).toBeGreaterThan(0);
    });

    it('never sends conversation history — only the new utterance', async () => {
      await service.handle(request('Привет'));
      expect(ai.startConversation).toHaveBeenCalledWith(
        'Привет',
        expect.anything(),
        expect.any(Number),
        expect.any(Function),
      );
    });

    it('fails loudly if the provider never reports the session id', async () => {
      // A session we cannot persist is a session nobody can ever reach again.
      ai.startConversation.mockImplementation(async () => completed());

      const response = await service.handle(request('Вопрос'));
      expect(response.response.text).toBe(PHRASES.openaiError);
    });
  });

  describe('follow-up question', () => {
    beforeEach(() => {
      conversations.getActiveConversation.mockResolvedValue(conversation());
    });

    it('reuses the stored session instead of creating a new one', async () => {
      await service.handle(request('А из капусты'));

      expect(ai.sendMessage).toHaveBeenCalledWith(SESSION_ID, 'А из капусты', 3200);
      expect(ai.startConversation).not.toHaveBeenCalled();
    });

    it('resumes the conversation after a restart using the session id from Postgres', async () => {
      // A fresh process has nothing in memory; Postgres supplies the session id.
      await service.handle(request('Продолжим'));
      expect(ai.sendMessage).toHaveBeenCalledWith(SESSION_ID, 'Продолжим', 3200);
    });

    it('starts a new session when the stored one is gone', async () => {
      ai.sendMessage.mockRejectedValueOnce(new ConversationUnavailableError('gone'));

      const response = await service.handle(request('Вопрос'));

      expect(conversations.archiveConversation).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(ai.startConversation).toHaveBeenCalled();
      expect(response.response.text).toBe('Ответ модели');
    });
  });

  describe('deferred answers', () => {
    beforeEach(() => {
      conversations.getActiveConversation.mockResolvedValue(conversation());
    });

    it('stores pending state and asks the user to come back', async () => {
      ai.sendMessage.mockResolvedValue(running());

      const response = await service.handle(request('Долгий вопрос'));

      expect(response.response.text).toBe(PHRASES.pendingStarted);
      expect(response.session_state).toEqual({ awaitingPending: true });
      expect(pending.setPending).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ providerSessionId: SESSION_ID, turnId: 'turn-1' }),
      );
      expect(usage.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ deferred: true }));
    });

    it('delivers the finished answer on a follow-up', async () => {
      pending.getPending.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        providerSessionId: SESSION_ID,
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
      });
      ai.getTurnOutcome.mockResolvedValue(completed('Готовый ответ'));

      const response = await service.handle(request('ну что'));

      expect(response.response.text).toBe('Готовый ответ');
      expect(pending.clearPending).toHaveBeenCalled();
      expect(usage.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ deferred: true }));
    });

    it('does not exceed the budget when reading the result is slow', async () => {
      // Alice has already hung up by the time a slow lookup returns; a stalled
      // read must degrade to "still thinking", not to a timeout.
      pending.getPending.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        providerSessionId: SESSION_ID,
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
      });
      // A promise that never settles — no timer to leak, and it models a
      // hung API call exactly.
      ai.getTurnOutcome.mockImplementation(() => new Promise(() => undefined));

      const started = Date.now();
      const response = await service.handle(request('ну что'));

      expect(Date.now() - started).toBeLessThan(4_000);
      expect(response.response.text).toBe(PHRASES.stillThinkingFollowUp);
      expect(pending.clearPending).not.toHaveBeenCalled();
    });

    it('says it is still thinking while the turn runs', async () => {
      pending.getPending.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        providerSessionId: SESSION_ID,
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
      });
      ai.getTurnOutcome.mockResolvedValue(running());

      const response = await service.handle(request('ну что'));

      expect(response.response.text).toBe(PHRASES.stillThinkingFollowUp);
      expect(pending.clearPending).not.toHaveBeenCalled();
    });

    it('tells the user there is nothing waiting when no turn is running', async () => {
      const response = await service.handle(request('ну что'));
      expect(response.response.text).toBe(PHRASES.nothingPending);
    });
  });

  describe('concurrency', () => {
    beforeEach(() => {
      conversations.getActiveConversation.mockResolvedValue(conversation());
    });

    it('refuses to start a second turn while one is running', async () => {
      pending.getPending.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        providerSessionId: SESSION_ID,
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
      });
      ai.getTurnOutcome.mockResolvedValue(running());

      const response = await service.handle(request('Новый вопрос во время работы'));

      expect(response.response.text).toBe(PHRASES.stillThinking);
      // Critically: the question is NOT sent into the active turn (no steering).
      expect(ai.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses when another request holds the lock', async () => {
      pending.acquireTurnLock.mockResolvedValue(null);

      const response = await service.handle(request('Параллельный вопрос'));

      expect(response.response.text).toBe(PHRASES.stillThinking);
      expect(ai.sendMessage).not.toHaveBeenCalled();
    });

    it('always releases the lock, even when the provider throws', async () => {
      ai.sendMessage.mockRejectedValue(new Error('boom'));

      await service.handle(request('Вопрос'));

      expect(pending.releaseTurnLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
    });
  });

  describe('required actions', () => {
    it('answers a blocked session instead of waiting forever', async () => {
      conversations.getActiveConversation.mockResolvedValue(conversation());
      pending.getPending.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        providerSessionId: SESSION_ID,
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
      });
      ai.getTurnOutcome.mockResolvedValue(running());
      ai.getSessionState.mockResolvedValue({
        sessionId: SESSION_ID,
        status: 'requires_action',
        model: 'gpt-6-luna',
        requiredActions: [
          {
            type: 'function_call',
            callId: 'call-1',
            name: 'unknown_tool',
            arguments: {},
            turnId: 'turn-1',
          },
        ],
      });

      const response = await service.handle(request('ну что'));

      expect(ai.resolveRequiredActions).toHaveBeenCalledWith(
        SESSION_ID,
        expect.arrayContaining([expect.objectContaining({ name: 'unknown_tool' })]),
      );
      expect(response.response.text).toBe(PHRASES.stillThinkingFollowUp);
    });
  });

  describe('failure handling', () => {
    beforeEach(() => {
      conversations.getActiveConversation.mockResolvedValue(conversation());
    });

    it('reports a failed turn in plain language', async () => {
      ai.sendMessage.mockResolvedValue({
        state: 'failed',
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        error: 'server_error',
      });

      const response = await service.handle(request('Вопрос'));
      expect(response.response.text).toBe(PHRASES.turnFailed);
    });

    it('reports a cancelled turn', async () => {
      ai.sendMessage.mockResolvedValue({
        state: 'cancelled',
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        error: 'cancelled',
      });

      const response = await service.handle(request('Вопрос'));
      expect(response.response.text).toBe(PHRASES.turnCancelled);
    });

    it('never leaks an OpenAI error to the speaker', async () => {
      ai.sendMessage.mockRejectedValue(new Error('401 Unauthorized: sk-secret'));

      const response = await service.handle(request('Вопрос'));

      expect(response.response.text).toBe(PHRASES.openaiError);
      expect(response.response.text).not.toContain('sk-');
    });

    it('surfaces a misconfigured agent id as a normal spoken error', async () => {
      ai.sendMessage.mockRejectedValue(new ProviderConfigurationError('agent not found'));

      const response = await service.handle(request('Вопрос'));
      expect(response.response.text).toBe(PHRASES.openaiError);
    });

    it('does not create sessions when Postgres is down', async () => {
      conversations.getOrCreateUser.mockRejectedValue(new Error('ECONNREFUSED'));

      const response = await service.handle(request('Вопрос'));

      expect(response.response.text).toBe(PHRASES.storageError);
      // Orphan-session guard: no session is created when we cannot store its id.
      expect(ai.startConversation).not.toHaveBeenCalled();
    });
  });

  describe('switching provider by voice', () => {
    it('remembers the choice and starts the conversation over', async () => {
      conversations.getActiveConversation.mockResolvedValue(conversation());

      const response = await service.handle(request('переключись на клода'));

      expect(pending.setProviderPreference).toHaveBeenCalledWith(
        expect.any(String),
        AiProvider.Claude,
      );
      // History cannot cross providers, so the old conversation is retired and
      // the user is told, rather than losing context silently.
      expect(conversations.archiveConversation).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(response.response.text).toBe(PHRASES.providerClaudeSelected);
    });

    it('understands "переключись на чатгпт"', async () => {
      pending.getProviderPreference.mockResolvedValue(AiProvider.Claude);

      const response = await service.handle(request('переключись на чатгпт'));

      expect(pending.setProviderPreference).toHaveBeenCalledWith(
        expect.any(String),
        AiProvider.Responses,
      );
      expect(response.response.tts).toContain('чат джи пи ти');
    });

    it('routes "на чатгпт" to OpenAI even when Claude is the default', async () => {
      // Targeting "the default provider" would be a no-op here: the default IS
      // Claude, so the command would silently do nothing.
      const claudeDefault = new AliceService(
        new AiProviderRegistry(
          new Map([
            [AiProvider.Responses, ai],
            [AiProvider.Claude, claude],
          ]),
          AiProvider.Claude,
        ),
        conversations,
        pending,
        usage,
        memory,
        new CommandParserService(),
        new AliceResponseService(
          new SpeechService({
            get: () => ({ maxVoiceResponseChars: 900 }),
          } as unknown as ConfigService<AppConfig, true>),
        ),
        config,
      );

      const response = await claudeDefault.handle(request('переключись на чатгпт'));

      expect(pending.setProviderPreference).toHaveBeenCalledWith(
        expect.any(String),
        AiProvider.Responses,
      );
      expect(response.response.text).toBe(PHRASES.providerOpenAiSelected.text);
    });

    it('says so when the provider is not configured', async () => {
      const onlyOpenAi = new AliceService(
        new AiProviderRegistry(new Map([[AiProvider.Responses, ai]]), AiProvider.Responses),
        conversations,
        pending,
        usage,
        memory,
        new CommandParserService(),
        new AliceResponseService(
          new SpeechService({
            get: () => ({ maxVoiceResponseChars: 900 }),
          } as unknown as ConfigService<AppConfig, true>),
        ),
        config,
      );

      const response = await onlyOpenAi.handle(request('переключись на клода'));

      expect(response.response.text).toBe(PHRASES.providerNotConfigured);
      expect(pending.setProviderPreference).not.toHaveBeenCalled();
    });

    it('routes the next question to the chosen provider', async () => {
      pending.getProviderPreference.mockResolvedValue(AiProvider.Claude);

      const response = await service.handle(request('Что приготовить'));

      expect(claude.startConversation).toHaveBeenCalled();
      expect(ai.startConversation).not.toHaveBeenCalled();
      expect(response.response.text).toBe('Ответ Клода');
    });

    it('never continues a conversation that belongs to another provider', async () => {
      // A foreign session id would be rejected by the API outright, so it is
      // archived and a new conversation opened instead.
      pending.getProviderPreference.mockResolvedValue(AiProvider.Claude);
      conversations.getActiveConversation.mockResolvedValue(
        conversation({ provider: AiProvider.Responses }),
      );

      await service.handle(request('Что приготовить'));

      expect(conversations.archiveConversation).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(claude.startConversation).toHaveBeenCalled();
    });

    it('reports who is answering', async () => {
      pending.getProviderPreference.mockResolvedValue(AiProvider.Claude);

      const response = await service.handle(request('кто отвечает'));

      expect(response.response.text).toBe(PHRASES.providerCurrentClaude);
    });
  });

  describe('service commands', () => {
    beforeEach(() => {
      conversations.getActiveConversation.mockResolvedValue(conversation());
    });

    it('archives the conversation without deleting the OpenAI session', async () => {
      const response = await service.handle(request('новый разговор'));

      expect(response.response.text).toBe(PHRASES.newConversation);
      expect(conversations.archiveConversation).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(pending.clearPending).toHaveBeenCalled();
      // No session is created yet: the Agents API has no empty sessions.
      expect(ai.startConversation).not.toHaveBeenCalled();
    });

    it('switches to the smart model for subsequent turns', async () => {
      const response = await service.handle(request('умная модель'));

      expect(pending.setModelProfile).toHaveBeenCalledWith(expect.any(String), 'smart');
      expect(ai.updateModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-6-sol');
      expect(response.response.text).toBe(PHRASES.modelSmartSelected);
    });

    it('switches to the fast model', async () => {
      await service.handle(request('быстрая модель'));
      expect(ai.updateModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-6-luna');
    });

    it('reports the current model without exposing the internal id', async () => {
      ai.getSessionState.mockResolvedValue({
        sessionId: SESSION_ID,
        status: 'idle',
        model: 'gpt-6-sol',
        requiredActions: [],
      });

      const response = await service.handle(request('какая модель'));

      expect(response.response.text).toBe(PHRASES.modelCurrentSmart);
      expect(response.response.text).not.toContain('gpt-6');
    });

    it('explains when the provider cannot switch models', async () => {
      // The Responses path has no per-conversation model, so it advertises no
      // profiles — the command must say so rather than pretend it worked.
      ai.modelProfiles.mockReturnValue({});

      const response = await service.handle(request('умная модель'));

      expect(response.response.text).toBe(PHRASES.modelSwitchDisabled);
      expect(ai.updateModel).not.toHaveBeenCalled();
    });
  });

  describe('user identity', () => {
    it('prefers the stable Yandex user id over the application id', async () => {
      await service.handle(
        request('Вопрос', {
          session: {
            session_id: 's',
            application: { application_id: 'app-123' },
            user: { user_id: 'yandex-user-9' },
          },
        }),
      );

      expect(conversations.getOrCreateUser).toHaveBeenCalledWith('yandex-user-9', 'user');
    });

    it('falls back to the application id for anonymous speakers', async () => {
      await service.handle(request('Вопрос'));
      expect(conversations.getOrCreateUser).toHaveBeenCalledWith('app-123', 'application');
    });
  });
});
