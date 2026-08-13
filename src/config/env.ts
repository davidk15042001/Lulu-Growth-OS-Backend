import { z } from 'zod';
import * as crypto from 'crypto';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }).optional(),
    DATABASE_SSL: booleanString.default(false),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    RUN_MIGRATIONS_ON_STARTUP: booleanString.default(true),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().min(2).default('24h'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    REFRESH_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    RESEND_API_KEY: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default('gpt-5.6-terra'),
    OPENAI_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_768).default(4_096),
    EMAIL_FROM: z.string().optional(),
    FRONTEND_BASE_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().optional(),
    TRUST_PROXY: booleanString.default(false),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') return;

    const required: Array<keyof typeof data> = ['RESEND_API_KEY', 'DATABASE_URL', 'CORS_ORIGIN'];

    for (const key of required) {
      if (!data[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in production`,
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

const raw = { ...process.env } as Record<string, string | undefined>;

if (!raw.JWT_SECRET && (raw.NODE_ENV ?? 'development') !== 'production') {
  raw.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[env] JWT_SECRET was not set. Generated a temporary dev secret. Tokens will reset on restart.');
}

const parsedEnv = EnvSchema.parse(raw);

export const env: Env = parsedEnv;

export const isProd = env.NODE_ENV === 'production';
export const hasDb = !!env.DATABASE_URL;
export const hasResend = !!env.RESEND_API_KEY;
export const hasOpenAI = !!env.OPENAI_API_KEY;
