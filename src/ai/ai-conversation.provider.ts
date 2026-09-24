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
   * Creates a durable session and submits the first user message.
   *
   * Returns as soon as the session id exists — the caller persists it *before*
   * waiting for the answer, so a slow turn can never leave an orphan session.
   */
  abstract createConversation(
    input: string,
    meta: ConversationMeta,
  ): Promise<{ sessionId: string }>;

  /** Waits for the session's current turn, giving up after `timeoutMs` without cancelling it. */
  abstract awaitCurrentTurn(sessionId: string, timeoutMs: number): Promise<TurnOutcome>;

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
