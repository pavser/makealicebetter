import type { AiProvider } from '../config/env.validation.js';
import type {
  ConversationMeta,
  RequiredAction,
  SessionState,
  TurnOutcome,
} from './types/ai.types.js';

/**
 * The single boundary between the app and whichever AI backend answers.
 *
 * Every difference between providers hides behind this contract — including the
 * big one: OpenAI remembers the conversation and lets us fetch a finished turn
 * by id, while Anthropic's Messages API is stateless and forces the provider to
 * keep both the history and the finished answer itself. Callers must not learn
 * which is which, otherwise `if (claude)` spreads through the orchestration.
 *
 * Used as the Nest DI token; {@link AiProviderRegistry} resolves the instance
 * for a given user.
 */
export abstract class AiConversationProvider {
  /** Identifies this provider in config, storage and voice commands. */
  abstract readonly name: AiProvider;

  /**
   * Creates a durable session, submits the first message and waits for the turn
   * — all on a single streamed request, because one round-trip to OpenAI costs
   * roughly a second and Alice only allows 4.5 of them in total.
   *
   * `onSessionCreated` fires as soon as the session id is known, well before the
   * answer arrives: the caller persists the id there, so a slow turn can never
   * leave an orphan session. The wait is never abandoned before that callback
   * has run.
   */
  abstract startConversation(
    input: string,
    meta: ConversationMeta,
    timeoutMs: number,
    onSessionCreated: (sessionId: string) => Promise<void>,
  ): Promise<TurnOutcome>;

  /** Sends a follow-up message to an idle session and waits up to `timeoutMs` for the turn. */
  abstract sendMessage(sessionId: string, input: string, timeoutMs: number): Promise<TurnOutcome>;

  /**
   * Reads the outcome of a turn that finished while nobody was listening.
   *
   * A turn id is often unknown: the Agents API can take several seconds to
   * create the turn, long after we stopped waiting. In that case `notBeforeMs`
   * says which turn we mean — without it the lookup could return the answer to
   * an earlier question.
   */
  abstract getTurnOutcome(
    sessionId: string,
    turnId: string | null,
    notBeforeMs?: number,
  ): Promise<TurnOutcome>;

  abstract getSessionState(sessionId: string): Promise<SessionState>;

  /** Answers pending function calls so a session never stays blocked. */
  abstract resolveRequiredActions(sessionId: string, actions: RequiredAction[]): Promise<void>;

  /** Switches the model for subsequent turns; conversation history is preserved. */
  abstract updateModel(sessionId: string, model: string): Promise<void>;

  /**
   * Verifies the provider can actually answer: credentials, and the agent or
   * model it is pointed at. Throws `ProviderConfigurationError` when it cannot.
   */
  abstract validateConfiguration(): Promise<void>;

  /** The models reachable by the "fast model" / "smart model" voice commands. */
  abstract modelProfiles(): { fast?: string; smart?: string };
}
