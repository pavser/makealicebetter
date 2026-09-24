import type {
  ConversationMeta,
  RequiredAction,
  SessionState,
  TurnOutcome,
} from './types/ai.types.js';

/**
 * The single boundary between the app and the (beta) OpenAI Agents API.
 *
 * Used as the Nest DI token, with {@link OpenAIAgentsService} in production and
 * a fake implementation for local verification. Keeping the surface this small
 * is deliberate: when the beta API changes, only one file has to follow.
 */
export abstract class AiConversationProvider {
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

  /** Reads the outcome of a turn that finished while nobody was listening. */
  abstract getTurnOutcome(sessionId: string, turnId: string | null): Promise<TurnOutcome>;

  abstract getSessionState(sessionId: string): Promise<SessionState>;

  /** Answers pending function calls so a session never stays blocked. */
  abstract resolveRequiredActions(sessionId: string, actions: RequiredAction[]): Promise<void>;

  /** Switches the model for subsequent turns; conversation history is preserved. */
  abstract updateModel(sessionId: string, model: string): Promise<void>;

  /** Verifies the configured agent id exists. Throws `AgentConfigurationError` when it does not. */
  abstract validateAgent(): Promise<void>;
}
