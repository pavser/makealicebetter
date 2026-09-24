/**
 * Long-term memory that spans conversations.
 *
 * This is *not* the dialogue context: the Agent Session already remembers the
 * current conversation. This abstraction exists for facts that should outlive a
 * session (preferences, recurring people, home setup) and is intentionally
 * unimplemented for now.
 */
export abstract class MemoryService {
  abstract getRelevantMemories(userKey: string, query: string): Promise<string[]>;

  abstract saveMemory(userKey: string, memory: string): Promise<void>;
}
