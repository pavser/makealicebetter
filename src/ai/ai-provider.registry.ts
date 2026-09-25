import { Injectable, Logger } from '@nestjs/common';

import { AiProvider } from '../config/env.validation.js';
import { AiConversationProvider } from './ai-conversation.provider.js';

/**
 * Holds every provider that is actually usable and resolves one per request.
 *
 * A provider without credentials is simply absent rather than broken: asking
 * for it returns null, and the caller answers "not configured" instead of
 * failing the user's question. That is what lets the skill ship with Claude
 * support while only an OpenAI key is present, or the other way round.
 */
@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger(AiProviderRegistry.name);

  constructor(
    private readonly providers: ReadonlyMap<AiProvider, AiConversationProvider>,
    readonly defaultProvider: AiProvider,
  ) {
    if (!providers.has(defaultProvider)) {
      // Reaching this means validation let a default through without its
      // credentials — better to fail loudly at boot than per request.
      throw new Error(`Default AI provider "${defaultProvider}" is not configured`);
    }
  }

  /** The provider for a stored preference, falling back to the default. */
  resolve(preferred?: AiProvider | null): AiConversationProvider {
    if (preferred && preferred !== this.defaultProvider) {
      const provider = this.providers.get(preferred);
      if (provider) {
        return provider;
      }
      // The preference outlived its configuration — for example the key was
      // removed while a user still had it selected in Redis.
      this.logger.warn(`Provider "${preferred}" is no longer configured; using the default`);
    }

    return this.providers.get(this.defaultProvider)!;
  }

  /** Null when the provider exists as an option but has no credentials. */
  find(name: AiProvider): AiConversationProvider | null {
    return this.providers.get(name) ?? null;
  }

  isConfigured(name: AiProvider): boolean {
    return this.providers.has(name);
  }

  all(): AiConversationProvider[] {
    return [...this.providers.values()];
  }
}
