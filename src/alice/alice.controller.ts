import { Body, Controller, HttpCode, Logger, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { AliceService } from './alice.service.js';
import { AliceWebhookDto } from './dto/alice-request.dto.js';
import { AliceExceptionFilter } from './filters/alice-exception.filter.js';
import { AliceSecretGuard } from './guards/alice-secret.guard.js';
import { PHRASES } from './phrases.js';
import { AliceResponseService } from './services/alice-response.service.js';
import type { AliceWebhookResponse } from './types/alice.types.js';

/** Thin by design: validation, secret check and skill-id check, then delegate. */
@Controller('api/alice')
@UseFilters(AliceExceptionFilter)
export class AliceController {
  private readonly logger = new Logger(AliceController.name);
  private readonly expectedSkillId?: string;

  constructor(
    private readonly alice: AliceService,
    private readonly responses: AliceResponseService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.expectedSkillId = config.get('alice', { infer: true }).skillId;
  }

  @Post(':secret')
  @HttpCode(200)
  @UseGuards(AliceSecretGuard)
  async handle(@Body() body: AliceWebhookDto): Promise<AliceWebhookResponse> {
    if (this.expectedSkillId && body.session.skill_id !== this.expectedSkillId) {
      this.logger.warn(`Rejected request for unexpected skill_id ${body.session.skill_id}`);
      return this.responses.say(PHRASES.wrongSkill, { endSession: true });
    }

    return this.alice.handle(body);
  }
}
