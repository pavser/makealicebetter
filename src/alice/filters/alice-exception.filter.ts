import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { PHRASES } from '../phrases.js';
import { ALICE_PROTOCOL_VERSION, type AliceWebhookResponse } from '../types/alice.types.js';

/**
 * Anything that escapes the webhook handler still has to come back as a valid
 * Alice response — the user must hear a sentence, never a stack trace or a 500.
 *
 * The one exception is a rejected secret: that request is not from Alice, so it
 * gets a plain 403.
 */
@Catch()
export class AliceExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AliceExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof ForbiddenException) {
      void reply.status(403).send({ message: 'Forbidden' });
      return;
    }

    const isValidation = exception instanceof HttpException && exception.getStatus() === 400;
    this.logger.error(
      `Alice webhook failed${isValidation ? ' (invalid payload)' : ''}: ${
        exception instanceof Error ? exception.message : String(exception)
      }`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // A malformed payload is not an outage — ask the user to repeat instead of
    // claiming the assistant is broken.
    const text = isValidation ? PHRASES.emptyCommand : PHRASES.openaiError;
    const body: AliceWebhookResponse = {
      response: { text, tts: text, end_session: false },
      version: ALICE_PROTOCOL_VERSION,
    };

    void reply.status(200).send(body);
  }
}
