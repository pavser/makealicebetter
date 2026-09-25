import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminModule } from './admin/admin.module.js';
import { AiProviderRegistry } from './ai/ai-provider.registry.js';
import { AiModule } from './ai/ai.module.js';
import { ProviderConfigurationError } from './ai/types/ai.types.js';
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

  constructor(private readonly registry: AiProviderRegistry) {}

  /**
   * One cheap call per provider at startup turns "OPENAI_AGENT_ID is wrong"
   * from a mystery at 3am into a clear log line. Each is checked separately so
   * one broken provider does not hide the health of the others, and none of it
   * blocks boot: readiness must not depend on a third party being reachable.
   */
  async onApplicationBootstrap(): Promise<void> {
    await Promise.all(
      this.registry.all().map(async (provider) => {
        try {
          await provider.validateConfiguration();
          this.logger.log(`Provider "${provider.name}" verified`);
        } catch (error) {
          if (error instanceof ProviderConfigurationError) {
            this.logger.error(`Provider "${provider.name}": ${error.message}`);
            return;
          }
          this.logger.warn(
            `Could not verify provider "${provider.name}" at startup: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }
}
