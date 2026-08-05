import { z } from 'zod';
import * as crypto from 'crypto';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }).optional(),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().optional(),
    FRONTEND_BASE_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') return;

    const required: Array<keyof typeof data> = [
      'RESEND_API_KEY',
      'DATABASE_URL',
    ];

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
