import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { AiConversationProvider } from './ai-conversation.provider.js';
import { FakeAgentsProvider } from './fake-agents.provider.js';
import { OpenAIAgentsService } from './openai-agents.service.js';
import { OpenAIResponsesService } from './openai-responses.service.js';

@Module({
  providers: [
    {
      provide: AiConversationProvider,
      inject: [ConfigService, ToolRegistryService],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        tools: ToolRegistryService,
      ): AiConversationProvider => {
        if (config.get('openai', { infer: true }).useFake) {
          new Logger('AiModule').warn(
            'OPENAI_FAKE=true — using the in-memory fake Agents provider. Never enable this in production.',
          );
          return new FakeAgentsProvider();
        }
        // The SDK client is built here so the services stay injectable with a
        // stub in tests.
        const client = OpenAIAgentsService.createClient(config);

        if (config.get('openai', { infer: true }).provider === 'agents') {
          return new OpenAIAgentsService(client, config, tools);
        }
        return new OpenAIResponsesService(client, config);
      },
    },
  ],
  exports: [AiConversationProvider],
})
export class AiModule {}
