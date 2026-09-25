import { AiProvider } from '../config/env.validation.js';
import type { AiConversationProvider } from './ai-conversation.provider.js';
import { AiProviderRegistry } from './ai-provider.registry.js';

const provider = (name: AiProvider): AiConversationProvider =>
  ({ name }) as unknown as AiConversationProvider;

const registry = (names: AiProvider[], fallback = AiProvider.Responses): AiProviderRegistry =>
  new AiProviderRegistry(new Map(names.map((name) => [name, provider(name)])), fallback);

describe('AiProviderRegistry', () => {
  it('uses the default when the user has no preference', () => {
    const resolved = registry([AiProvider.Responses, AiProvider.Claude]).resolve(null);

    expect(resolved.name).toBe(AiProvider.Responses);
  });

  it('honours a stored preference', () => {
    const resolved = registry([AiProvider.Responses, AiProvider.Claude]).resolve(AiProvider.Claude);

    expect(resolved.name).toBe(AiProvider.Claude);
  });

  it('falls back when the preferred provider lost its credentials', () => {
    // The key was removed while a user still had Claude selected in Redis.
    // Answering with the default beats failing their question.
    const resolved = registry([AiProvider.Responses]).resolve(AiProvider.Claude);

    expect(resolved.name).toBe(AiProvider.Responses);
  });

  it('reports an unconfigured provider rather than pretending it exists', () => {
    const subject = registry([AiProvider.Responses]);

    expect(subject.isConfigured(AiProvider.Claude)).toBe(false);
    expect(subject.find(AiProvider.Claude)).toBeNull();
  });

  it('refuses to start when the default itself is missing', () => {
    // Validation should have caught this; failing at boot beats failing on
    // every request with no clue why.
    expect(() => registry([AiProvider.Claude], AiProvider.Responses)).toThrow(
      /Default AI provider/,
    );
  });

  it('lists every provider so startup can verify each one', () => {
    const all = registry([AiProvider.Responses, AiProvider.Claude]).all();

    expect(all.map((item) => item.name)).toEqual([AiProvider.Responses, AiProvider.Claude]);
  });
});
