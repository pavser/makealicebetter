import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppConfig } from '../config/configuration.js';
import { AiProvider } from '../config/env.validation.js';
import { ConversationHistoryService } from '../conversations/conversation-history.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { AiConversationProvider } from './ai-conversation.provider.js';
import { AiProviderRegistry } from './ai-provider.registry.js';
import { ClaudeMessagesService } from './claude-messages.service.js';
import { createAnthropicClient } from './clients/anthropic-client.factory.js';
import { createOpenAIClient } from './clients/openai-client.factory.js';
import { FakeAgentsProvider } from './fake-agents.provider.js';
import { OpenAIAgentsService } from './openai-agents.service.js';
import { OpenAIResponsesService } from './openai-responses.service.js';

/** Shipped in the repo; `ANTHROPIC_SYSTEM_PROMPT` overrides it. */
const PROMPT_FILE = join(import.meta.dirname, '..', '..', 'prompts', 'voice-assistant.ru.md');

async function loadSystemPrompt(configured?: string): Promise<string> {
  if (configured) {
    return configured;
  }

  try {
    return (await readFile(PROMPT_FILE, 'utf8')).trim();
  } catch (error) {
    // Losing the prompt would silently turn the assistant into a generic chat
    // bot that reads markdown aloud, so this is worth failing on.
    throw new Error(`Could not read the system prompt at ${PROMPT_FILE}`, { cause: error });
  }
}

/**
 * Builds every provider whose credentials are present.
 *
 * The fake short-circuits everything, as before — e2e runs without any key.
 */
async function buildRegistry(
  config: ConfigService<AppConfig, true>,
  tools: ToolRegistryService,
  history: ConversationHistoryService,
): Promise<AiProviderRegistry> {
  const ai = config.get('ai', { infer: true });
  const logger = new Logger('AiModule');
  const providers = new Map<AiProvider, AiConversationProvider>();

  if (ai.useFake) {
    logger.warn(
      'OPENAI_FAKE=true — using the in-memory fake provider. Never enable this in production.',
    );
    // Registered under the default name so the rest of the app is unchanged.
    providers.set(ai.defaultProvider, new FakeAgentsProvider(ai.defaultProvider));
    return new AiProviderRegistry(providers, ai.defaultProvider);
  }

  if (ai.openai.apiKey && ai.openai.agentId) {
    const client = createOpenAIClient(config);
    providers.set(AiProvider.Responses, new OpenAIResponsesService(client, config));
    providers.set(AiProvider.Agents, new OpenAIAgentsService(client, config, tools));
  }

  if (ai.anthropic.apiKey) {
    const systemPrompt = await loadSystemPrompt(ai.anthropic.systemPrompt);
    providers.set(
      AiProvider.Claude,
      new ClaudeMessagesService(createAnthropicClient(config), history, config, systemPrompt),
    );
  }

  logger.log(
    `Providers configured: ${[...providers.keys()].join(', ')} (default: ${ai.defaultProvider})`,
  );
  return new AiProviderRegistry(providers, ai.defaultProvider);
}

@Module({
  imports: [ConversationsModule],
  providers: [
    {
      provide: AiProviderRegistry,
      inject: [ConfigService, ToolRegistryService, ConversationHistoryService],
      useFactory: buildRegistry,
    },
  ],
  exports: [AiProviderRegistry],
})
export class AiModule {}
