import { Injectable } from '@nestjs/common';

import { SpeechService } from '../../speech/speech.service.js';
import {
  ALICE_PROTOCOL_VERSION,
  AWAITING_PENDING_STATE_KEY,
  type AliceWebhookResponse,
} from '../types/alice.types.js';

interface ResponseOptions {
  /** Remembered in session_state so the next short reply is read as a follow-up. */
  awaitingPending?: boolean;
  endSession?: boolean;
}

/** Builds protocol-correct Alice responses; the only place that knows the wire format. */
@Injectable()
export class AliceResponseService {
  constructor(private readonly speech: SpeechService) {}

  /** For the skill's own phrases, which are already speech-friendly. */
  say(text: string, options: ResponseOptions = {}): AliceWebhookResponse {
    return this.build(text, text, options);
  }

  /**
   * For phrases containing a name that is written one way and pronounced
   * another — "ЧатGPT" on the card, "чат-джи-пи-ти" out loud.
   */
  sayWithTts(text: string, tts: string, options: ResponseOptions = {}): AliceWebhookResponse {
    return this.build(text, tts, options);
  }

  /** For model output, which may still contain markdown or be too long. */
  fromAssistantAnswer(answer: string, options: ResponseOptions = {}): AliceWebhookResponse {
    const spoken = this.speech.prepareForSpeech(answer);
    return this.build(spoken.text, spoken.tts, options);
  }

  private build(text: string, tts: string, options: ResponseOptions): AliceWebhookResponse {
    const response: AliceWebhookResponse = {
      response: {
        text,
        tts,
        end_session: options.endSession ?? false,
      },
      version: ALICE_PROTOCOL_VERSION,
    };

    // State is only kept when echoed back, so we set it exclusively while waiting.
    if (options.awaitingPending) {
      response.session_state = { [AWAITING_PENDING_STATE_KEY]: true };
    }

    return response;
  }
}
