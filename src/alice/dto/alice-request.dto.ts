import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * Validation is deliberately permissive: only the fields this skill actually
 * reads are checked, and unknown fields are kept as-is. Yandex adds optional
 * fields to the protocol over time and that must never break the webhook.
 */
export class AliceApplicationDto {
  @IsString()
  @IsNotEmpty()
  application_id!: string;
}

export class AliceUserDto {
  /** Stable across devices; present only for signed-in Yandex users. */
  @IsOptional()
  @IsString()
  user_id?: string;
}

export class AliceSessionDto {
  @IsString()
  @IsNotEmpty()
  session_id!: string;

  @IsOptional()
  @IsString()
  skill_id?: string;

  @IsOptional()
  @IsBoolean()
  new?: boolean;

  @IsObject()
  @ValidateNested()
  @Type(() => AliceApplicationDto)
  application!: AliceApplicationDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AliceUserDto)
  user?: AliceUserDto;

  /** Deprecated by Yandex in favour of application.application_id; accepted, not used. */
  @IsOptional()
  @IsString()
  user_id?: string;
}

export class AliceRequestPayloadDto {
  /** SimpleUtterance | ButtonPressed | Show.Pull | … — kept open on purpose. */
  @IsString()
  type!: string;

  @IsOptional()
  @IsString()
  command?: string;

  @IsOptional()
  @IsString()
  original_utterance?: string;
}

export class AliceStateDto {
  @IsOptional()
  @IsObject()
  session?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  user?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  application?: Record<string, unknown>;
}

export class AliceWebhookDto {
  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => AliceSessionDto)
  session!: AliceSessionDto;

  @IsObject()
  @ValidateNested()
  @Type(() => AliceRequestPayloadDto)
  request!: AliceRequestPayloadDto;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AliceStateDto)
  state?: AliceStateDto;
}
