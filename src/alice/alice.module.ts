import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { PendingModule } from '../pending/pending.module.js';
import { SpeechModule } from '../speech/speech.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { AliceController } from './alice.controller.js';
import { AliceService } from './alice.service.js';
import { AliceResponseService } from './services/alice-response.service.js';
import { CommandParserService } from './services/command-parser.service.js';

@Module({
  imports: [AiModule, ConversationsModule, PendingModule, UsageModule, MemoryModule, SpeechModule],
  controllers: [AliceController],
  providers: [AliceService, AliceResponseService, CommandParserService],
})
export class AliceModule {}
