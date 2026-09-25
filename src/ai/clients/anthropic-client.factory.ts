import Anthropic from '@anthropic-ai/sdk';
import type { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration.js';

/** Builds the Anthropic client. See {@link createOpenAIClient} for the rationale. */
export function createAnthropicClient(config: ConfigService<AppConfig, true>): Anthropic {
  const anthropic = config.get('ai', { infer: true }).anthropic;
  return new Anthropic({
    apiKey: anthropic.apiKey,
    timeout: anthropic.requestTimeoutMs,
    maxRetries: 1,
  });
}
