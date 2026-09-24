import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { AiConversationProvider } from './ai-conversation.provider.js';
import { FakeAgentsProvider } from './fake-agents.provider.js';
import { OpenAIAgentsService } from './openai-agents.service.js';

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
        // The SDK client is built here so the service itself stays injectable
        // with a stub in tests.
        return new OpenAIAgentsService(OpenAIAgentsService.createClient(config), config, tools);
      },
    },
  ],
  exports: [AiConversationProvider],
})
export class AiModule {}
