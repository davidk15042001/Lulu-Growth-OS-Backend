import { z } from 'zod';
import * as crypto from 'crypto';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().min(1).optional());

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }).optional(),
    DATABASE_SSL: booleanString.default(false),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    RUN_MIGRATIONS_ON_STARTUP: booleanString.default(true),
    BACKGROUND_WORKERS_ENABLED: booleanString.default(true),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().min(2).default('7d'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(3650),
    REFRESH_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    MAILCOW_SMTP_HOST: z.string().min(1).optional(),
    MAILCOW_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    MAILCOW_SMTP_SECURE: booleanString.default(false),
    MAILCOW_SMTP_USER: z.string().min(1).optional(),
    MAILCOW_SMTP_PASS: z.string().min(1).optional(),
    AI_PROVIDER: z.enum(['openai', 'alibaba', 'deepseek', 'groq']).default('deepseek'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default('gpt-5-mini'),
    DASHSCOPE_API_KEY: z.string().min(1).optional(),
    DASHSCOPE_BASE_URL: z.string().url().default('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
    DASHSCOPE_MODEL: z.string().min(1).default('qwen3.7-plus'),
    DEEPSEEK_API_KEY: z.string().min(1).optional(),
    DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    DEEPSEEK_MODEL: z.string().min(1).default('deepseek-v4-pro'),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    GROQ_MODEL: z.string().min(1).default('llama-3.3-70b-versatile'),
    OPENAI_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_768).default(4_096),
    IMAGE_MODEL: z.string().min(1).default('gpt-image-1'),
    IMAGE_SIZE: z.string().min(1).default('1024x1024'),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    TRANSLATION_GLOBAL_CHARACTER_LIMIT_PER_HOUR: z.coerce.number().int().min(10_000).max(100_000_000).default(2_000_000),
    WEBSITE_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
    WEBSITE_JOB_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(90),
    WEBSITE_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    ONBOARDING_FILE_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    PAYG_BILLING_WORKER_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    PAYG_SERVER_COST_USD_PER_DAY: z.coerce.number().min(0).max(100_000).default(0),
    PAYG_INVOICE_DAYS_UNTIL_DUE: z.coerce.number().int().min(1).max(30).default(7),
    EMAIL_FROM: z.string().optional(),
    FRONTEND_BASE_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().optional(),
    TRUST_PROXY: booleanString.default(false),
    AWS_REGION: z.string().min(1).default('eu-central-1'),
    AWS_S3_BUCKET: z.string().min(1).optional(),
    AWS_S3_ENDPOINT: z.string().url().optional(),
    AWS_S3_FORCE_PATH_STYLE: booleanString.default(false),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    OAUTH_CALLBACK_BASE_URL: z.string().url().optional(),
    CALENDAR_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    CALENDAR_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    CALENDAR_MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
    CALENDAR_MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
    CALENDAR_MICROSOFT_TENANT: z.string().regex(/^[a-zA-Z0-9.-]+$/).default('common'),
    CALENDAR_CALCOM_ALLOWED_HOSTS: z.string().min(1).default('api.cal.com'),
    CALENDAR_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
    CALENDAR_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    EMAIL_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    EMAIL_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    EMAIL_MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
    EMAIL_MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
    EMAIL_MICROSOFT_TENANT: z.string().regex(/^[a-zA-Z0-9.-]+$/).default('common'),
    EMAIL_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    EMAIL_SYNC_MESSAGE_LIMIT: z.coerce.number().int().min(10).max(500).default(100),
    SALESFORCE_CLIENT_ID: z.string().min(1).optional(),
    SALESFORCE_CLIENT_SECRET: z.string().min(1).optional(),
    SALESFORCE_AUTH_URL: z.string().url().default('https://login.salesforce.com/services/oauth2/authorize'),
    SALESFORCE_TOKEN_URL: z.string().url().default('https://login.salesforce.com/services/oauth2/token'),
    PIPEDRIVE_CLIENT_ID: z.string().min(1).optional(),
    PIPEDRIVE_CLIENT_SECRET: z.string().min(1).optional(),
    HUBSPOT_CLIENT_ID: z.string().min(1).optional(),
    HUBSPOT_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(1).optional(),
    META_CLIENT_ID: z.string().min(1).optional(),
    META_CLIENT_SECRET: z.string().min(1).optional(),
    META_GRAPH_VERSION: z.string().regex(/^v[0-9.]+$/).default('v23.0'),
    LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
    LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
    WEBFLOW_CLIENT_ID: z.string().min(1).optional(),
    WEBFLOW_CLIENT_SECRET: z.string().min(1).optional(),
    WORDPRESS_CLIENT_ID: z.string().min(1).optional(),
    WORDPRESS_CLIENT_SECRET: z.string().min(1).optional(),
    SHOPIFY_CLIENT_ID: z.string().min(1).optional(),
    SHOPIFY_CLIENT_SECRET: z.string().min(1).optional(),
    SHOPIFY_SCOPES: z.string().default('read_products,read_content'),
    DATAFORSEO_API_KEY: optionalNonEmptyString,
    DATAFORSEO_LOGIN: optionalNonEmptyString,
    DATAFORSEO_PASSWORD: optionalNonEmptyString,
    DATAFORSEO_BASE_URL: z.string().url().default('https://api.dataforseo.com'),
    AIRWALLEX_CLIENT_ID: z.string().min(1).optional(),
    AIRWALLEX_API_KEY: z.string().min(1).optional(),
    AIRWALLEX_BASE_URL: z.string().url().default('https://api.sandbox.airwallex.com'),
    AIRWALLEX_LEGAL_ENTITY_ID: z.string().min(1).optional(),
    AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID: z.string().min(1).optional(),
    AIRWALLEX_STARTER_PRICE_ID: z.string().min(1).optional(),
    AIRWALLEX_AI_PRICE_ID: z.string().min(1).optional(),
    AIRWALLEX_TEST_PRICE_ID: z.string().min(1).optional(),
    AIRWALLEX_WEBHOOK_SECRET: z.string().min(1).optional(),
    AIRWALLEX_LOGIN_AS: z.string().min(1).optional(),
    AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') return;

    if (data.AI_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai in production' });
    }
    if (data.AI_PROVIDER === 'alibaba' && !data.DASHSCOPE_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DASHSCOPE_API_KEY'], message: 'DASHSCOPE_API_KEY is required when AI_PROVIDER=alibaba in production' });
    }
    if (data.AI_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEEPSEEK_API_KEY'], message: 'DEEPSEEK_API_KEY is required when AI_PROVIDER=deepseek in production' });
    }
    if (data.AI_PROVIDER === 'groq' && !data.GROQ_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['GROQ_API_KEY'], message: 'GROQ_API_KEY is required when AI_PROVIDER=groq in production' });
    }

    const required: Array<keyof typeof data> = ['DATABASE_URL', 'CORS_ORIGIN'];

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

// `.env.example` intentionally documents optional settings with empty values.
// Treat those values as absent so optional schemas and defaults behave the same
// whether a variable is omitted or copied as `NAME=`.
for (const [name, value] of Object.entries(raw)) {
  if (typeof value === 'string' && value.trim() === '') delete raw[name];
}

if (!raw.JWT_SECRET && (raw.NODE_ENV ?? 'development') !== 'production') {
  raw.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[env] JWT_SECRET was not set. Generated a temporary dev secret. Tokens will reset on restart.');
}

const parsedEnv = EnvSchema.parse(raw);

export const env: Env = parsedEnv;

export const isProd = env.NODE_ENV === 'production';
export const hasDb = !!env.DATABASE_URL;
export const hasOpenAI = env.AI_PROVIDER === 'openai' && !!env.OPENAI_API_KEY;
export const hasAlibaba = env.AI_PROVIDER === 'alibaba' && !!env.DASHSCOPE_API_KEY;
export const hasDeepSeek = env.AI_PROVIDER === 'deepseek' && !!env.DEEPSEEK_API_KEY;
export const hasGroq = env.AI_PROVIDER === 'groq' && !!env.GROQ_API_KEY;
export const hasAiProvider = hasOpenAI || hasAlibaba || hasDeepSeek || hasGroq;
