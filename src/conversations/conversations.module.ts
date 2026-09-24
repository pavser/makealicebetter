import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationsService } from './conversations.service.js';
import { ConversationEntity } from './entities/conversation.entity.js';
import { TurnRecordEntity } from './entities/turn-record.entity.js';
import { UserEntity } from './entities/user.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, ConversationEntity, TurnRecordEntity])],
  providers: [ConversationsService],
  exports: [ConversationsService, TypeOrmModule],
})
export class ConversationsModule {}
