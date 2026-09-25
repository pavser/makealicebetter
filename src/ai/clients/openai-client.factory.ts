import type { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { AppConfig } from '../../config/configuration.js';

/**
 * Builds the OpenAI client shared by both OpenAI providers.
 *
 * Separate from the services so neither has to reach into the other, and so
 * tests can pass a stub client instead.
 */
export function createOpenAIClient(config: ConfigService<AppConfig, true>): OpenAI {
  const openai = config.get('ai', { infer: true }).openai;
  return new OpenAI({
    apiKey: openai.apiKey,
    timeout: openai.requestTimeoutMs,
    // Retrying a submitted message could duplicate a user turn; one retry of
    // the connection attempt is enough for our latency budget. Hot-path calls
    // override this with `maxRetries: 0`.
    maxRetries: 1,
  });
}
