import { Module } from '@nestjs/common';

import { ConversationsModule } from '../conversations/conversations.module.js';
import { PendingModule } from '../pending/pending.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { AdminController } from './admin.controller.js';

@Module({
  imports: [UsageModule, ConversationsModule, PendingModule],
  controllers: [AdminController],
})
export class AdminModule {}
