export const ALICE_PROTOCOL_VERSION = '1.0';

/** Key we put into `session_state` to remember that an answer is still coming. */
export const AWAITING_PENDING_STATE_KEY = 'awaitingPending';

export interface AliceButton {
  title: string;
  hide?: boolean;
}

export interface AliceResponsePayload {
  text: string;
  tts?: string;
  buttons?: AliceButton[];
  end_session: boolean;
}

export interface AliceWebhookResponse {
  response: AliceResponsePayload;
  session_state?: Record<string, unknown>;
  version: string;
}

/** Identity of the speaker, resolved from the current Dialogs protocol. */
export interface AliceIdentity {
  aliceUserId: string;
  idSource: 'user' | 'application';
  /** Short, non-reversible id used in logs and Redis keys. */
  userKey: string;
}
