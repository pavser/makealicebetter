import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { AiConversationProvider } from '../ai/ai-conversation.provider.js';
import { AgentSessionUnavailableError, type TurnOutcome } from '../ai/types/ai.types.js';
import type { AppConfig } from '../config/configuration.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import type { ConversationEntity } from '../conversations/entities/conversation.entity.js';
import { MemoryService } from '../memory/memory.service.js';
import { type ModelProfile, PendingService } from '../pending/pending.service.js';
import { UsageService } from '../usage/usage.service.js';
import { AliceWebhookDto } from './dto/alice-request.dto.js';
import { PHRASES } from './phrases.js';
import { AliceResponseService } from './services/alice-response.service.js';
import { CommandParserService } from './services/command-parser.service.js';
import {
  AWAITING_PENDING_STATE_KEY,
  type AliceIdentity,
  type AliceWebhookResponse,
} from './types/alice.types.js';

interface RequestContext {
  identity: AliceIdentity;
  command: string;
  awaitingPending: boolean;
}

/**
 * Even when the budget is already spent we still glance at the stream: a fast
 * answer may arrive within these few hundred milliseconds, and giving up
 * without looking would send every first question into the deferred flow.
 */
const MIN_WAIT_MS = 300;

/**
 * Orchestrates one Alice turn.
 *
 * The flow never blocks longer than the soft timeout: if the Agent turn is not
 * done by then we stop listening (the turn keeps running on OpenAI's side),
 * remember it in Redis and tell the user to ask again in a moment.
 */
@Injectable()
export class AliceService {
  private readonly logger = new Logger(AliceService.name);
  private readonly softTimeoutMs: number;
  private readonly models: { fast?: string; smart?: string };

  constructor(
    private readonly ai: AiConversationProvider,
    private readonly conversations: ConversationsService,
    private readonly pending: PendingService,
    private readonly usage: UsageService,
    private readonly memory: MemoryService,
    private readonly parser: CommandParserService,
    private readonly responses: AliceResponseService,
    config: ConfigService<AppConfig, true>,
  ) {
    const alice = config.get('alice', { infer: true });
    const openai = config.get('openai', { infer: true });
    this.softTimeoutMs = alice.softTimeoutMs;
    this.models = { fast: openai.modelFast, smart: openai.modelSmart };
  }

  async handle(dto: AliceWebhookDto): Promise<AliceWebhookResponse> {
    const identity = this.resolveIdentity(dto);
    const command = (dto.request.command ?? dto.request.original_utterance ?? '').trim();
    const awaitingPending = dto.state?.session?.[AWAITING_PENDING_STATE_KEY] === true;

    if (!command) {
      // Skill launch or an empty utterance: never send this to the model.
      return this.responses.say(dto.session.new ? PHRASES.greeting : PHRASES.emptyCommand);
    }

    const context: RequestContext = { identity, command, awaitingPending };
    const parsed = this.parser.parse(command, awaitingPending);

    if (parsed === 'help') {
      return this.responses.say(PHRASES.help);
    }

    let conversation: ConversationEntity | null;
    let userId: string;
    try {
      const user = await this.conversations.getOrCreateUser(
        identity.aliceUserId,
        identity.idSource,
      );
      userId = user.id;
      conversation = await this.conversations.getActiveConversation(user.id);
    } catch (error) {
      // Without the mapping we cannot tell which session is the user's, and
      // creating a new one on every request would leak orphan sessions.
      this.logger.error(`Postgres unavailable for ${identity.userKey}: ${this.describe(error)}`);
      return this.responses.say(PHRASES.storageError);
    }

    switch (parsed) {
      case 'new_conversation':
        return this.startNewConversation(context, conversation);
      case 'model_fast':
      case 'model_smart':
        return this.switchModel(context, conversation, parsed === 'model_fast' ? 'fast' : 'smart');
      case 'which_model':
        return this.reportModel(context, conversation);
      case 'pending_followup':
        return this.resumePending(context, conversation);
      default:
        return this.ask(context, userId, conversation);
    }
  }

  // --- main question flow --------------------------------------------------

  private async ask(
    context: RequestContext,
    userId: string,
    conversation: ConversationEntity | null,
  ): Promise<AliceWebhookResponse> {
    const { identity, command } = context;

    const busy = await this.rejectIfBusy(context);
    if (busy) {
      return busy;
    }

    const lockToken = await this.pending.acquireTurnLock(identity.userKey);
    if (!lockToken) {
      // A concurrent request for the same user is already starting a turn.
      return this.responses.say(PHRASES.stillThinking, { awaitingPending: true });
    }

    const startedAt = Date.now();
    try {
      const input = await this.buildInput(identity.userKey, command);
      let active = conversation;
      let outcome: TurnOutcome;

      try {
        ({ active, outcome } = await this.runTurn(identity, userId, active, input, startedAt));
      } catch (error) {
        if (error instanceof AgentSessionUnavailableError && active) {
          // The stored session is gone on OpenAI's side — start a fresh one once.
          this.logger.warn(`Session ${active.openaiSessionId} unavailable; starting a new one`);
          await this.conversations.archiveConversation(active.id);
          ({ active, outcome } = await this.runTurn(identity, userId, null, input, startedAt));
        } else {
          throw error;
        }
      }

      return await this.respondToOutcome(context, active, outcome, Date.now() - startedAt);
    } catch (error) {
      this.logger.error(`Agent request failed for ${identity.userKey}: ${this.describe(error)}`);
      return this.responses.say(PHRASES.openaiError);
    } finally {
      await this.pending.releaseTurnLock(identity.userKey, lockToken);
    }
  }

  /**
   * Runs one turn within whatever is left of the request's time budget.
   *
   * The deadline counts from the moment the request arrived, not from the start
   * of the wait: everything before it — database lookups, creating the session —
   * also spends Alice's 4.5 seconds.
   */
  private async runTurn(
    identity: AliceIdentity,
    userId: string,
    conversation: ConversationEntity | null,
    input: string,
    startedAt: number,
  ): Promise<{ active: ConversationEntity; outcome: TurnOutcome }> {
    const budgetMs = Math.max(this.softTimeoutMs - (Date.now() - startedAt), MIN_WAIT_MS);

    if (conversation) {
      const outcome = await this.ai.sendMessage(conversation.openaiSessionId, input, budgetMs);
      return { active: conversation, outcome };
    }

    // A session cannot be created empty (the Agents API requires an input when
    // environment.type is "none"), so creation and the first question happen on
    // one streamed request — a second round-trip would cost about a second.
    let created: ConversationEntity | null = null;

    const outcome = await this.ai.startConversation(
      input,
      { userHash: identity.userKey },
      budgetMs,
      async (sessionId) => {
        // Persist the mapping before the answer arrives: a slow turn must never
        // orphan a session.
        created = await this.conversations.startConversation(userId, sessionId);

        // Model settings only affect later turns anyway, so this must not eat
        // into the budget — fire it off and keep going.
        void this.applyStoredModelProfile(identity.userKey, sessionId);
      },
    );

    if (!created) {
      throw new Error('Agent session was never reported as created');
    }
    return { active: created, outcome };
  }

  private async respondToOutcome(
    context: RequestContext,
    conversation: ConversationEntity,
    outcome: TurnOutcome,
    latencyMs: number,
  ): Promise<AliceWebhookResponse> {
    const { identity } = context;

    switch (outcome.state) {
      case 'completed': {
        await Promise.all([
          this.pending.clearPending(identity.userKey),
          this.usage.recordTurn({
            conversationId: conversation.id,
            outcome,
            latencyMs,
            deferred: false,
          }),
          this.conversations.touch(conversation.id),
        ]);
        this.logTurn(context, conversation, outcome, latencyMs, 'direct');
        return outcome.text
          ? this.responses.fromAgentAnswer(outcome.text)
          : this.responses.say(PHRASES.turnFailed);
      }

      case 'running': {
        await Promise.all([
          this.pending.setPending(identity.userKey, {
            conversationId: conversation.id,
            openaiSessionId: conversation.openaiSessionId,
            turnId: outcome.turnId,
            startedAt: new Date().toISOString(),
          }),
          this.usage.recordTurn({
            conversationId: conversation.id,
            outcome,
            latencyMs,
            deferred: true,
          }),
        ]);
        this.logTurn(context, conversation, outcome, latencyMs, 'deferred');
        return this.responses.say(PHRASES.pendingStarted, { awaitingPending: true });
      }

      default: {
        await Promise.all([
          this.pending.clearPending(identity.userKey),
          this.usage.recordTurn({
            conversationId: conversation.id,
            outcome,
            latencyMs,
            deferred: false,
          }),
        ]);
        this.logTurn(context, conversation, outcome, latencyMs, 'direct');
        return this.responses.say(
          outcome.state === 'cancelled' ? PHRASES.turnCancelled : PHRASES.turnFailed,
        );
      }
    }
  }

  // --- deferred answers ----------------------------------------------------

  /** Answers "ну что" and friends by reading the outcome of the remembered turn. */
  private async resumePending(
    context: RequestContext,
    conversation: ConversationEntity | null,
  ): Promise<AliceWebhookResponse> {
    const { identity } = context;
    const pending = await this.pending.getPending(identity.userKey);

    if (!pending) {
      // Redis may have been restarted; Postgres still knows the session, so ask
      // OpenAI whether a turn is actually running before giving up.
      if (conversation && (await this.isSessionBusy(conversation.openaiSessionId))) {
        return this.responses.say(PHRASES.stillThinkingFollowUp, { awaitingPending: true });
      }
      return this.responses.say(PHRASES.nothingPending);
    }

    let outcome: TurnOutcome;
    try {
      outcome = await this.withinBudget(
        this.ai.getTurnOutcome(
          pending.openaiSessionId,
          pending.turnId,
          // Without the id, the turn is identified by the moment we started
          // it — otherwise an earlier answer could be replayed as this one.
          new Date(pending.startedAt).getTime(),
        ),
        { state: 'running', sessionId: pending.openaiSessionId, turnId: pending.turnId },
      );
    } catch (error) {
      this.logger.error(`Failed to read pending turn: ${this.describe(error)}`);
      return this.responses.say(PHRASES.openaiError);
    }

    if (outcome.state === 'running') {
      // The turn may be blocked on a function call we only learn about now
      // (required actions raised after we stopped listening to the stream).
      await this.unblockRequiredActions(pending.openaiSessionId);
      return this.responses.say(PHRASES.stillThinkingFollowUp, { awaitingPending: true });
    }

    await this.pending.clearPending(identity.userKey);
    await this.usage.recordTurn({
      conversationId: pending.conversationId,
      outcome,
      latencyMs: Date.now() - new Date(pending.startedAt).getTime(),
      deferred: true,
    });

    if (outcome.state === 'completed') {
      this.logger.log(
        `user=${identity.userKey} mode=pending-delivered turn=${outcome.turnId ?? 'unknown'}`,
      );
      return outcome.text
        ? this.responses.fromAgentAnswer(outcome.text)
        : this.responses.say(PHRASES.turnFailed);
    }

    return this.responses.say(
      outcome.state === 'cancelled' ? PHRASES.turnCancelled : PHRASES.turnFailed,
    );
  }

  /**
   * Blocks a new heavy turn while the previous one is still running, instead of
   * sending the question into the active turn (which the Agents API would treat
   * as steering and mix into the current answer).
   */
  private async rejectIfBusy(context: RequestContext): Promise<AliceWebhookResponse | null> {
    const pending = await this.pending.getPending(context.identity.userKey);
    if (!pending) {
      return null;
    }

    try {
      const outcome = await this.withinBudget(
        this.ai.getTurnOutcome(
          pending.openaiSessionId,
          pending.turnId,
          new Date(pending.startedAt).getTime(),
        ),
        { state: 'running' as const, sessionId: pending.openaiSessionId, turnId: pending.turnId },
      );
      if (outcome.state === 'running') {
        await this.unblockRequiredActions(pending.openaiSessionId);
        return this.responses.say(PHRASES.stillThinking, { awaitingPending: true });
      }

      // The previous turn finished but was never collected: drop the marker and
      // record its usage, then let the new question through.
      await this.pending.clearPending(context.identity.userKey);
      await this.usage.recordTurn({
        conversationId: pending.conversationId,
        outcome,
        latencyMs: Date.now() - new Date(pending.startedAt).getTime(),
        deferred: true,
      });
      return null;
    } catch (error) {
      this.logger.warn(`Could not check pending turn: ${this.describe(error)}`);
      await this.pending.clearPending(context.identity.userKey);
      return null;
    }
  }

  /**
   * Caps any lookup at the request's budget.
   *
   * Reading a finished turn normally takes under a second, but the Agents API
   * has been seen to take tens of seconds. Alice would be long gone by then, so
   * we answer "still thinking" and let the next follow-up collect the result —
   * the work itself keeps running on OpenAI's side either way.
   */
  private async withinBudget<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), this.softTimeoutMs);
    });

    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A session that asked for a function result stays blocked until somebody
   * answers. Inside the event stream the SDK handles that; once we stopped
   * listening it is on us, otherwise the turn would wait forever.
   */
  private async unblockRequiredActions(sessionId: string): Promise<void> {
    try {
      const state = await this.ai.getSessionState(sessionId);
      if (state.status !== 'requires_action' || state.requiredActions.length === 0) {
        return;
      }

      this.logger.warn(
        `Session ${sessionId} is waiting for ${state.requiredActions.length} action(s); answering them`,
      );
      await this.ai.resolveRequiredActions(sessionId, state.requiredActions);
    } catch (error) {
      this.logger.warn(`Could not resolve required actions: ${this.describe(error)}`);
    }
  }

  private async isSessionBusy(sessionId: string): Promise<boolean> {
    try {
      const state = await this.withinBudget(this.ai.getSessionState(sessionId), null);
      return state?.status === 'in_progress';
    } catch (error) {
      this.logger.warn(`Could not read session state: ${this.describe(error)}`);
      return false;
    }
  }

  // --- service commands ----------------------------------------------------

  private async startNewConversation(
    context: RequestContext,
    conversation: ConversationEntity | null,
  ): Promise<AliceWebhookResponse> {
    await this.pending.clearPending(context.identity.userKey);

    if (conversation) {
      // The OpenAI session is kept on purpose: archiving is local bookkeeping,
      // deleting remote sessions is a separate maintenance decision.
      await this.conversations.archiveConversation(conversation.id);
    }

    this.logger.log(`user=${context.identity.userKey} action=new-conversation`);
    // The next question creates the new session — the API has no empty sessions.
    return this.responses.say(PHRASES.newConversation);
  }

  private async switchModel(
    context: RequestContext,
    conversation: ConversationEntity | null,
    profile: ModelProfile,
  ): Promise<AliceWebhookResponse> {
    const model = profile === 'fast' ? this.models.fast : this.models.smart;
    if (!model) {
      return this.responses.say(PHRASES.modelSwitchDisabled);
    }

    await this.pending.setModelProfile(context.identity.userKey, profile);

    if (conversation) {
      try {
        // Applies from the next turn onwards; conversation history is preserved.
        await this.ai.updateModel(conversation.openaiSessionId, model);
      } catch (error) {
        this.logger.warn(`Failed to switch model: ${this.describe(error)}`);
        return this.responses.say(PHRASES.openaiError);
      }
    }

    return this.responses.say(
      profile === 'fast' ? PHRASES.modelFastSelected : PHRASES.modelSmartSelected,
    );
  }

  private async reportModel(
    context: RequestContext,
    conversation: ConversationEntity | null,
  ): Promise<AliceWebhookResponse> {
    let model: string | null = null;
    if (conversation) {
      try {
        model = (await this.ai.getSessionState(conversation.openaiSessionId)).model;
      } catch (error) {
        this.logger.warn(`Failed to read session model: ${this.describe(error)}`);
      }
    }

    if (model && this.models.fast && model === this.models.fast) {
      return this.responses.say(PHRASES.modelCurrentFast);
    }
    if (model && this.models.smart && model === this.models.smart) {
      return this.responses.say(PHRASES.modelCurrentSmart);
    }

    // Fall back to the stored profile when the session is gone or the model is
    // whatever the saved Agent uses by default.
    const profile = await this.pending.getModelProfile(context.identity.userKey);
    if (!model && profile === 'fast') {
      return this.responses.say(PHRASES.modelCurrentFast);
    }
    if (!model && profile === 'smart') {
      return this.responses.say(PHRASES.modelCurrentSmart);
    }

    return this.responses.say(PHRASES.modelCurrentDefault);
  }

  private async applyStoredModelProfile(userKey: string, sessionId: string): Promise<void> {
    const profile = await this.pending.getModelProfile(userKey);
    const model =
      profile === 'fast' ? this.models.fast : profile === 'smart' ? this.models.smart : undefined;
    if (!model) {
      return;
    }

    try {
      await this.ai.updateModel(sessionId, model);
    } catch (error) {
      this.logger.warn(`Failed to apply stored model profile: ${this.describe(error)}`);
    }
  }

  // --- helpers -------------------------------------------------------------

  /**
   * The Agent Session already holds the conversation, so the input is just the
   * user's line. Long-term memories (currently none) are the only extra context
   * this backend ever adds.
   */
  private async buildInput(userKey: string, command: string): Promise<string> {
    const memories = await this.memory.getRelevantMemories(userKey, command);
    if (memories.length === 0) {
      return command;
    }
    return `Полезное из прошлых разговоров:\n${memories.join('\n')}\n\nВопрос: ${command}`;
  }

  private resolveIdentity(dto: AliceWebhookDto): AliceIdentity {
    // session.user_id is deprecated; a signed-in user has a stable user.user_id,
    // everyone else is identified per application installation.
    const userId = dto.session.user?.user_id;
    const aliceUserId = userId ?? dto.session.application.application_id;

    return {
      aliceUserId,
      idSource: userId ? 'user' : 'application',
      userKey: createHash('sha256').update(aliceUserId).digest('hex').slice(0, 16),
    };
  }

  private logTurn(
    context: RequestContext,
    conversation: ConversationEntity,
    outcome: TurnOutcome,
    latencyMs: number,
    mode: 'direct' | 'deferred',
  ): void {
    const usage = outcome.state === 'completed' ? outcome.usage : null;
    this.logger.log(
      `user=${context.identity.userKey} conversation=${conversation.id} ` +
        `turn=${outcome.turnId ?? 'unknown'} state=${outcome.state} mode=${mode} ` +
        `latency=${latencyMs}ms tokens=${usage ? `${usage.inputTokens}/${usage.outputTokens}` : 'n/a'}`,
    );
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
