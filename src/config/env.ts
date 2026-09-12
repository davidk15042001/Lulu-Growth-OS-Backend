import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().min(1).optional());

const optionalTestPlanPassword = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? undefined : value;
}, z.string().min(12).max(128).optional());

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }).optional(),
    DATABASE_SSL: booleanString.default(false),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    // Production deployments run migrations explicitly before restarting the
    // API. Keeping this off by default prevents a web worker from blocking
    // its HTTP startup indefinitely behind a stale migration advisory lock.
    RUN_MIGRATIONS_ON_STARTUP: booleanString.default(false),
    BACKGROUND_WORKERS_ENABLED: booleanString.default(true),
    EVENT_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
    EVENT_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    EVENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
    EVENT_WORKER_LEASE_SECONDS: z.coerce.number().int().min(15).max(900).default(60),
    AGENT_RUN_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
    AGENT_RUN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
    AGENT_RUN_WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(1_800).default(900),
    AGENT_RUN_WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    CONTENT_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    CONTENT_JOB_LEASE_SECONDS: z.coerce.number().int().min(60).max(3_600).default(1_800),
    CONTENT_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().regex(/^([1-9]\d*)(s|m|h|d)$/).default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(30).transform(days => Math.min(days, 90)),
    PROVIDER_CREDENTIAL_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    PROVIDER_CREDENTIAL_KEY_FILE: optionalNonEmptyString,
    PROVIDER_CREDENTIAL_KEY_VERSION: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).default('1'),
    PROVIDER_CREDENTIAL_PREVIOUS_KEYS: z.string().optional(),
    PROVIDER_CREDENTIAL_LEGACY_KEY: z.string().min(32).optional(),
    DOMAIN_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    REFRESH_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    MAILCOW_SMTP_HOST: z.string().min(1).optional(),
    MAILCOW_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    MAILCOW_SMTP_SECURE: booleanString.default(false),
    MAILCOW_SMTP_USER: z.string().min(1).optional(),
    MAILCOW_SMTP_PASS: z.string().min(1).optional(),
    AI_PROVIDER: z.enum(['openai', 'alibaba', 'deepseek', 'groq', 'kie']).default('deepseek'),
    AI_PROVIDER_FALLBACK_ORDER: z.string().default('openai,alibaba,deepseek,groq,kie'),
    AI_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
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
    // Kie.ai is Lulu's premium media gateway. The API key remains strictly
    // server-side; model defaults intentionally select quality tiers only.
    KIE_API_KEY: optionalNonEmptyString,
    KIE_BASE_URL: z.string().url().default('https://api.kie.ai'),
    KIE_UPLOAD_BASE_URL: z.string().url().default('https://kieai.redpandaai.co'),
    KIE_CALLBACK_BASE_URL: z.string().url().optional(),
    KIE_PREMIUM_IMAGE_MODELS: z.string().default('flux-2/pro-image-to-image,seedream/5-pro-image-to-image'),
    KIE_PREMIUM_TEXT_IMAGE_MODELS: z.string().default('flux-2/pro-text-to-image,seedream/5-pro-text-to-image'),
    KIE_PREMIUM_VIDEO_MODELS: z.string().default('kling/v3-turbo-image-to-video,veo3'),
    KIE_IMAGE_RESOLUTION: z.enum(['1K', '2K']).default('2K'),
    KIE_VIDEO_RESOLUTION: z.enum(['720p', '1080p']).default('720p'),
    KIE_IMAGE_UPSCALE_FACTOR: z.coerce.number().int().min(2).max(4).default(2),
    KIE_VIDEO_UPSCALE_FACTOR: z.coerce.number().int().min(2).max(4).default(2),
    KIE_QUALITY_MODEL: z.string().min(1).default('gemini-3-pro'),
    KIE_QUALITY_MODEL_PATH: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).default('/gemini-3-pro/v1/chat/completions'),
    KIE_IMAGE_QUALITY_THRESHOLD: z.coerce.number().int().min(70).max(100).default(92),
    KIE_VIDEO_QUALITY_THRESHOLD: z.coerce.number().int().min(70).max(100).default(90),
    KIE_MEDIA_MAX_ROUNDS: z.coerce.number().int().min(1).max(5).default(3),
    KIE_MEDIA_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
    KIE_MEDIA_POLL_AFTER_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
    KIE_MEDIA_TASK_TIMEOUT_MINUTES: z.coerce.number().int().min(15).max(1_440).default(90),
    KIE_MEDIA_MAX_DOWNLOAD_MB: z.coerce.number().int().min(10).max(1_000).default(250),
    KIE_MEDIA_ALLOWED_DOWNLOAD_HOSTS: z.string().default('aiquickdraw.com,redpandaai.co'),
    // Credits are metered into Lulu's existing PAYG API ledger. Keep this
    // configurable because the effective price changes with Kie credit packs.
    KIE_CREDIT_COST_USD: z.coerce.number().min(0).max(100).default(0.005),
    KIE_CUSTOMER_MARKUP_MULTIPLIER: z.coerce.number().min(1).max(20).default(2),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    // Customer AI usage is priced in USD and atomically debited from a CNY
    // wallet. Persist the rate with every debit; never fetch a mutable rate
    // after the customer has consumed the service.
    API_USD_CNY_RATE: z.coerce.number().positive().max(20).default(7.2),
    TRANSLATION_GLOBAL_CHARACTER_LIMIT_PER_HOUR: z.coerce.number().int().min(10_000).max(100_000_000).default(2_000_000),
    WEBSITE_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
    WEBSITE_JOB_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(90),
    WEBSITE_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    ONBOARDING_FILE_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    PAYG_BILLING_WORKER_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    PAYG_SERVER_COST_USD_PER_DAY: z.coerce.number().min(0).max(100_000).default(0),
    PAYG_INVOICE_DAYS_UNTIL_DUE: z.coerce.number().int().min(1).max(30).default(7),
    AIRWALLEX_PAYG_DIRECT_PAYMENT_METHODS: z.string().default('card,alipaycn,wechatpay'),
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
    AGORA_APP_ID: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(),
    AGORA_APP_CERTIFICATE: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(),
    AGORA_CUSTOMER_ID: z.string().min(1).optional(),
    AGORA_CUSTOMER_KEY: z.string().min(1).optional(),
    AGORA_CUSTOMER_SECRET: z.string().min(1).optional(),
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
    GOOGLE_ADS_PREPAID_BILLING_ENABLED: z.enum(['true','false']).default('false').transform(value=>value==='true'),
    META_CLIENT_ID: z.string().min(1).optional(),
    META_CLIENT_SECRET: z.string().min(1).optional(),
    META_GRAPH_VERSION: z.string().regex(/^v[0-9.]+$/).default('v23.0'),
    LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
    LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
    TIKTOK_ADS_CLIENT_ID: z.string().min(1).optional(),
    TIKTOK_ADS_CLIENT_SECRET: z.string().min(1).optional(),
    TIKTOK_ADS_AUTH_URL: z.string().url().default('https://business-api.tiktok.com/portal/auth'),
    TIKTOK_ADS_TOKEN_URL: z.string().url().default('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/'),
    TIKTOK_ADS_SCOPES: z.string().default('user.info.basic,advertiser.read,ad.read,ad.write'),
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
    BILLING_TEST_PLAN_PASSWORD: optionalTestPlanPassword,
    AIRWALLEX_WEBHOOK_SECRET: z.string().min(1).optional(),
    AIRWALLEX_LOGIN_AS: z.string().min(1).optional(),
    AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
    // Platform-scoped Twilio transport. Prefer a restricted API key for REST
    // calls; the auth token is also required to validate Twilio webhooks.
    TWILIO_ACCOUNT_SID: optionalNonEmptyString,
    TWILIO_API_KEY_SID: optionalNonEmptyString,
    TWILIO_API_KEY_SECRET: optionalNonEmptyString,
    TWILIO_AUTH_TOKEN: optionalNonEmptyString,
    TWILIO_RUNTIME_ENV_FILE: optionalNonEmptyString,
    TWILIO_BASE_URL: z.string().url().default('https://api.twilio.com'),
    TWILIO_WEBHOOK_URL: z.string().url().optional(),
    TWILIO_STATUS_CALLBACK_URL: z.string().url().optional(),
    TWILIO_WHATSAPP_FROM: optionalNonEmptyString,
    TWILIO_MESSENGER_FROM: optionalNonEmptyString,
    // Approved WhatsApp template used when Lulu must contact a customer
    // outside Meta's 24-hour free-form service window. The template should
    // contain one {{1}} variable for the generated message text.
    TWILIO_WHATSAPP_CONTENT_SID: z.string().regex(/^HX[a-fA-F0-9]{32}$/).optional(),
    // Deprecated compatibility variables. No new OmniChannel delivery uses
    // UnifyPort, but the old adapter remains readable during migration.
    UNIFYPORT_API_KEY: optionalNonEmptyString,
    UNIFYPORT_BASE_URL: z.string().url().default('https://api.unifyport.ai'),
    UNIFYPORT_WEBHOOK_SIGNING_SECRET: optionalNonEmptyString,
    // JSON map of provider key -> webhook signing secret. Secrets remain
    // server-side; providers without a configured verifier stay unverified.
    PROVIDER_WEBHOOK_SECRETS: z.string().optional(),
    PROVIDER_SYNC_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
    PROVIDER_SYNC_JOB_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(120),
    PROVIDER_SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    PROVIDER_WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
    PROVIDER_WEBHOOK_LEASE_SECONDS: z.coerce.number().int().min(15).max(900).default(60),
    PROVIDER_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  })
  .superRefine((data, ctx) => {
    if (Boolean(data.TWILIO_API_KEY_SID) !== Boolean(data.TWILIO_API_KEY_SECRET)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TWILIO_API_KEY_SECRET'], message: 'TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be configured together' });
    }
    if ((data.TWILIO_API_KEY_SID || data.TWILIO_AUTH_TOKEN) && !data.TWILIO_ACCOUNT_SID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TWILIO_ACCOUNT_SID'], message: 'TWILIO_ACCOUNT_SID is required when Twilio credentials are configured' });
    }
    if (data.TWILIO_WHATSAPP_CONTENT_SID && !data.TWILIO_WHATSAPP_FROM) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TWILIO_WHATSAPP_FROM'], message: 'TWILIO_WHATSAPP_FROM is required when a WhatsApp content template is configured' });
    }
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
    if (data.AI_PROVIDER === 'kie' && !data.KIE_API_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['KIE_API_KEY'], message: 'KIE_API_KEY is required when AI_PROVIDER=kie in production' });
    }
    // Provider credentials may predate the dedicated encryption key.  Keeping
    // the key optional lets those legacy v1 credentials remain readable while
    // the application is being upgraded. New provider credentials are still
    // rejected by secret-box until an independent key is configured, rather
    // than falling back to the JWT signing secret for new writes.
    if (data.PROVIDER_CREDENTIAL_KEY && crypto.createHash('sha256').update(data.JWT_SECRET, 'utf8').digest('hex').toLowerCase() === data.PROVIDER_CREDENTIAL_KEY.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PROVIDER_CREDENTIAL_KEY'], message: 'PROVIDER_CREDENTIAL_KEY must be independent from JWT_SECRET' });
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

if ((raw.NODE_ENV ?? 'development') === 'production') {
  const twilioSecretFile = path.resolve(raw.TWILIO_RUNTIME_ENV_FILE ?? path.join(process.cwd(), '.runtime-secrets', 'twilio.env'));
  try {
    const allowed = new Set(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WEBHOOK_URL', 'TWILIO_STATUS_CALLBACK_URL']);
    for (const line of fs.readFileSync(twilioSecretFile, 'utf8').split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith('#') || !line.includes('=')) continue;
      const separator = line.indexOf('=');
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (allowed.has(key) && value && !raw[key]) raw[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[env] Twilio runtime secret file is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

// Production hosts may keep the dedicated provider key in a deployment-stable
// local file instead of a root-owned environment file. The file is created
// atomically with owner-only permissions and never enters the repository.
if ((raw.NODE_ENV ?? 'development') === 'production' && !raw.PROVIDER_CREDENTIAL_KEY) {
  const keyFile = path.resolve(raw.PROVIDER_CREDENTIAL_KEY_FILE ?? path.join(process.cwd(), '.runtime-secrets', 'provider-credential-key'));
  try {
    let key: string;
    try {
      key = fs.readFileSync(keyFile, 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      const generated = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(keyFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        key = generated;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        key = fs.readFileSync(keyFile, 'utf8').trim();
      }
    }
    if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Provider credential key file must contain exactly 64 hexadecimal characters');
    raw.PROVIDER_CREDENTIAL_KEY = key;
  } catch (error) {
    console.warn(`[env] Provider credential key file is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

if (!raw.JWT_SECRET && (raw.NODE_ENV ?? 'development') !== 'production') {
  raw.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[env] JWT_SECRET was not set. Generated a temporary dev secret. Tokens will reset on restart.');
}

const parsedEnv = EnvSchema.parse(raw);

export const env: Env = parsedEnv;

export const isProd = env.NODE_ENV === 'production';
// The production host terminates TLS in a local reverse proxy. Trust loopback
// by default so client IPs and rate limits work without trusting arbitrary
// remote forwarding headers. TRUST_PROXY=true remains an explicit one-hop mode.
export const trustProxySetting: false | 1 | 'loopback' = env.TRUST_PROXY ? 1 : isProd ? 'loopback' : false;
export const hasDb = !!env.DATABASE_URL;
// Availability is intentionally independent from the preferred provider so a
// configured secondary provider can take over when the primary is unavailable.
export const hasOpenAI = !!env.OPENAI_API_KEY;
export const hasAlibaba = !!env.DASHSCOPE_API_KEY;
export const hasDeepSeek = !!env.DEEPSEEK_API_KEY;
export const hasGroq = !!env.GROQ_API_KEY;
export const hasKie = !!env.KIE_API_KEY;
export const hasAiProvider = hasOpenAI || hasAlibaba || hasDeepSeek || hasGroq || hasKie;
