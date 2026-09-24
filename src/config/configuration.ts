import { EnvironmentVariables, NodeEnv, validateEnv } from './env.validation.js';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  logLevel?: string;
  openai: {
    apiKey: string;
    agentId: string;
    modelFast?: string;
    modelSmart?: string;
    requestTimeoutMs: number;
    useFake: boolean;
  };
  alice: {
    webhookSecret: string;
    skillId?: string;
    softTimeoutMs: number;
    maxVoiceResponseChars: number;
  };
  postgres: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    pendingStateTtlSeconds: number;
  };
  admin: {
    apiKey?: string;
  };
}

/**
 * Builds the typed config tree. Validation already ran in `validateEnv`,
 * so every value here is guaranteed to be present and well-formed.
 */
export function buildConfig(env: EnvironmentVariables): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    openai: {
      apiKey: env.OPENAI_API_KEY,
      agentId: env.OPENAI_AGENT_ID,
      modelFast: env.OPENAI_MODEL_FAST,
      modelSmart: env.OPENAI_MODEL_SMART,
      requestTimeoutMs: env.OPENAI_REQUEST_TIMEOUT_MS,
      useFake: env.OPENAI_FAKE,
    },
    alice: {
      webhookSecret: env.ALICE_WEBHOOK_SECRET,
      skillId: env.ALICE_SKILL_ID,
      softTimeoutMs: env.ALICE_LLM_SOFT_TIMEOUT_MS,
      maxVoiceResponseChars: env.MAX_VOICE_RESPONSE_CHARS,
    },
    postgres: {
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
    },
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
      pendingStateTtlSeconds: env.PENDING_STATE_TTL_SECONDS,
    },
    admin: {
      apiKey: env.ADMIN_API_KEY,
    },
  };
}

/** `load` callback for `ConfigModule.forRoot`. */
export default (): AppConfig => buildConfig(validateEnv(process.env));
