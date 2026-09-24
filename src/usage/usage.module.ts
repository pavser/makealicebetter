import { Module } from '@nestjs/common';

import { ConversationsModule } from '../conversations/conversations.module.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [ConversationsModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
