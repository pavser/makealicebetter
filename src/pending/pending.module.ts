import { Module } from '@nestjs/common';

import { PendingService } from './pending.service.js';

@Module({
  providers: [PendingService],
  exports: [PendingService],
})
export class PendingModule {}
