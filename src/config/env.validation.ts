import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

/**
 * Which OpenAI API answers the user.
 *
 * `responses` is the default: measured on the production host it answers in
 * 1.4-2.7s against 12.1s for `agents`, and Yandex Dialogs allow 4.5s in total.
 * `agents` keeps the durable Agent Session path for long, tool-heavy work.
 */
export enum AiProvider {
  Responses = 'responses',
  Agents = 'agents',
}

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Yandex Dialogs rejects responses whose text/tts exceed 1024 characters,
 * so the configured limit can never be raised above that.
 */
export const ALICE_TEXT_HARD_LIMIT = 1024;

const toInt = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
};

const toBool = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  // Anything else fails validation with a clear message instead of being coerced.
  return value;
};

const emptyToUndefined = ({ value }: { value: unknown }): unknown =>
  value === '' ? undefined : value;

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsOptional()
  LOG_LEVEL?: string;

  // --- OpenAI ---
  @IsEnum(AiProvider)
  @IsOptional()
  AI_PROVIDER: AiProvider = AiProvider.Responses;

  @Transform(toBool)
  @IsBoolean()
  @IsOptional()
  OPENAI_FAKE: boolean = false;

  /** Not required when running against the in-memory fake provider. */
  @ValidateIf((env: EnvironmentVariables) => !env.OPENAI_FAKE)
  @IsString()
  @IsNotEmpty()
  OPENAI_API_KEY!: string;

  @ValidateIf((env: EnvironmentVariables) => !env.OPENAI_FAKE)
  @IsString()
  @IsNotEmpty()
  OPENAI_AGENT_ID!: string;

  @Transform(emptyToUndefined)
  @IsString()
  @IsOptional()
  OPENAI_MODEL_FAST?: string;

  @Transform(emptyToUndefined)
  @IsString()
  @IsOptional()
  OPENAI_MODEL_SMART?: string;

  @Transform(toInt)
  @IsInt()
  @Min(1000)
  @IsOptional()
  OPENAI_REQUEST_TIMEOUT_MS: number = 30_000;

  // --- Alice ---
  @IsString()
  @IsNotEmpty()
  ALICE_WEBHOOK_SECRET!: string;

  @Transform(emptyToUndefined)
  @IsString()
  @IsOptional()
  ALICE_SKILL_ID?: string;

  @Transform(toInt)
  @IsInt()
  @Min(500)
  @Max(4_000)
  @IsOptional()
  ALICE_LLM_SOFT_TIMEOUT_MS: number = 2_500;

  @Transform(toInt)
  @IsInt()
  @Min(100)
  @Max(ALICE_TEXT_HARD_LIMIT)
  @IsOptional()
  MAX_VOICE_RESPONSE_CHARS: number = 900;

  // --- PostgreSQL ---
  @IsString()
  @IsNotEmpty()
  POSTGRES_HOST!: string;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  POSTGRES_PORT!: number;

  @IsString()
  @IsNotEmpty()
  POSTGRES_USER!: string;

  @IsString()
  @IsNotEmpty()
  POSTGRES_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()
  POSTGRES_DB!: string;

  // --- Redis ---
  @IsString()
  @IsNotEmpty()
  REDIS_HOST!: string;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT!: number;

  @Transform(emptyToUndefined)
  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  @IsOptional()
  REDIS_DB: number = 0;

  @Transform(toInt)
  @IsInt()
  @Min(30)
  @IsOptional()
  PENDING_STATE_TTL_SECONDS: number = 600;

  // --- Admin ---
  @Transform(emptyToUndefined)
  @IsString()
  @IsOptional()
  ADMIN_API_KEY?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }

  return validated;
}
