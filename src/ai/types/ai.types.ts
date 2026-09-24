/** Token usage for a single Agent turn, mirroring the SDK's `TokenUsage`. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
  cachedTokens: number | null;
}

export type TurnState = 'completed' | 'running' | 'failed' | 'cancelled';

/**
 * Outcome of one Agent turn as the rest of the app sees it.
 *
 * `running` is not a failure: the turn keeps executing on OpenAI's side after we
 * stop waiting, and its result is fetched later via {@link AiConversationProvider.getTurnOutcome}.
 */
export type TurnOutcome =
  | {
      state: 'completed';
      sessionId: string;
      turnId: string | null;
      text: string;
      usage: TurnUsage | null;
      model: string | null;
    }
  | {
      state: 'running';
      sessionId: string;
      turnId: string | null;
      /** The model is searching the web — worth telling the user, it explains the wait. */
      searching?: boolean;
    }
  | { state: 'failed' | 'cancelled'; sessionId: string; turnId: string | null; error: string };

export type SessionStatus = 'idle' | 'in_progress' | 'requires_action' | 'failed';

export interface RequiredFunctionCall {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: unknown;
  turnId: string;
}

export interface RequiredEnvironmentConnection {
  type: 'environment_connection';
  environmentId: string;
}

export type RequiredAction = RequiredFunctionCall | RequiredEnvironmentConnection;

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  model: string | null;
  requiredActions: RequiredAction[];
}

/** Non-sensitive labels attached to the OpenAI session for debugging. */
export interface ConversationMeta {
  /** Hashed Alice user id — never the raw identifier. */
  userHash: string;
}

export class AgentConfigurationError extends Error {}
export class AgentSessionUnavailableError extends Error {}
