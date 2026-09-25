import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationHistoryService } from './conversation-history.service.js';
import { ConversationsService } from './conversations.service.js';
import { ConversationEntity } from './entities/conversation.entity.js';
import { MessageEntity } from './entities/message.entity.js';
import { TurnRecordEntity } from './entities/turn-record.entity.js';
import { UserEntity } from './entities/user.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, ConversationEntity, TurnRecordEntity, MessageEntity]),
  ],
  providers: [ConversationsService, ConversationHistoryService],
  exports: [ConversationsService, ConversationHistoryService, TypeOrmModule],
})
export class ConversationsModule {}
