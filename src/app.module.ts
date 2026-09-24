import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminModule } from './admin/admin.module.js';
import { AiConversationProvider } from './ai/ai-conversation.provider.js';
import { AiModule } from './ai/ai.module.js';
import { AgentConfigurationError } from './ai/types/ai.types.js';
import { AliceModule } from './alice/alice.module.js';
import configuration from './config/configuration.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { ToolsModule } from './tools/tools.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
    }),
    DatabaseModule,
    RedisModule,
    ToolsModule,
    AiModule,
    AliceModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly ai: AiConversationProvider) {}

  /**
   * One cheap call at startup turns "OPENAI_AGENT_ID is wrong" from a mystery at
   * 3am into a clear log line. It never blocks boot: readiness must not depend
   * on OpenAI being reachable.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ai.validateAgent();
      this.logger.log('OpenAI agent configuration verified');
    } catch (error) {
      if (error instanceof AgentConfigurationError) {
        this.logger.error(error.message);
        return;
      }
      this.logger.warn(
        `Could not verify the OpenAI agent at startup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
