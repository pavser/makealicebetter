import { Module } from '@nestjs/common';

import { MemoryService } from './memory.service.js';
import { NoopMemoryService } from './noop-memory.service.js';

@Module({
  providers: [{ provide: MemoryService, useClass: NoopMemoryService }],
  exports: [MemoryService],
})
export class MemoryModule {}
