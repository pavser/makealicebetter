import { Injectable } from '@nestjs/common';

import { MemoryService } from './memory.service.js';

/** Default implementation: remembers nothing, so no memories are injected. */
@Injectable()
export class NoopMemoryService extends MemoryService {
  getRelevantMemories(): Promise<string[]> {
    return Promise.resolve([]);
  }

  saveMemory(): Promise<void> {
    return Promise.resolve();
  }
}
