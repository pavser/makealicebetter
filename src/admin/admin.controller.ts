import { Controller, Get, UseGuards } from '@nestjs/common';

import { ConversationsService } from '../conversations/conversations.service.js';
import { PendingService } from '../pending/pending.service.js';
import { UsageService, type UsageSummary } from '../usage/usage.service.js';
import { AdminApiKeyGuard } from './guards/admin-api-key.guard.js';

interface UsageResponse extends UsageSummary {
  activeUsers: number;
  users: number;
  conversations: number;
  pendingTurns: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

@Controller('api/admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  constructor(
    private readonly usage: UsageService,
    private readonly conversations: ConversationsService,
    private readonly pending: PendingService,
  ) {}

  /** Aggregated from locally stored turn records — never from the OpenAI billing API. */
  @Get('usage')
  async getUsage(): Promise<UsageResponse> {
    const [summary, activeUsers, users, conversations, pendingTurns] = await Promise.all([
      this.usage.getSummary(),
      this.usage.countActiveUsers(new Date(Date.now() - THIRTY_DAYS_MS)),
      this.conversations.countUsers(),
      this.conversations.countConversations(),
      this.pending.countPendingTurns(),
    ]);

    return { ...summary, activeUsers, users, conversations, pendingTurns };
  }
}
