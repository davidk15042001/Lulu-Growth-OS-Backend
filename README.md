# Lulu Growth OS Backend

Multi-tenant TypeScript/Express API and PostgreSQL data layer for the Lulu Growth OS frontend.

## Included

- Email/password authentication, refresh-token rotation and password reset codes
- Workspace isolation with `owner`, `admin`, `member` and `viewer` roles, invitations and member management
- Complete onboarding persistence for company data, offerings, platforms and AI preferences
- 98 typed resource categories covering CRM, Sales, Marketing, Advertising, Ecommerce, Finance, Intelligence and AI
- Searchable, paginated records with optimistic version checks, audit history and soft delete
- Metric definitions and time-series points for dashboards and intelligence views
- Notifications, AI conversations, approval requests, background jobs, integration sync runs and webhooks
- Workspace bootstrap summaries, saved views, audit feeds, subscription state, usage counters and idempotency storage
- Optional OpenAI Responses API adapter with non-persisted provider requests
- PostgreSQL migrations with transaction and deployment locking
- Automated HTTP, validation, catalog, OpenAI adapter and migration contract tests
- A 145-agent capability registry with dynamic team selection, performance-based routing and independent automated outcome verification
- Autonomous premium product-media production through Kie.ai: dual-model image and video candidates, independent multimodal QA, Topaz finishing, automatic retries and private permanent storage

## Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer, or Docker Desktop

Docker is optional. A hosted PostgreSQL database such as Supabase can be used through `DATABASE_URL`.

## Local setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Copy `.env.example` to `.env` and replace `JWT_SECRET` with a random value of at least 32 characters.
   Leave `BACKGROUND_WORKERS_ENABLED=true` for local all-in-one development.

3. Start PostgreSQL with Docker when Docker is available:

   ```bash
   npm run db:up
   ```

4. Apply migrations:

   ```bash
   npm run migrate
   ```

5. Start the development API:

   ```bash
   npm run dev
   ```

The API runs at `http://localhost:4000` by default.

## Verification

```bash
npm run check
```

This runs strict TypeScript validation, all SQL migrations in a PostgreSQL-compatible test engine, API/unit tests, and the production build.

## Event-driven runtime

Asynchronous business workflows use the durable PostgreSQL event runtime in `src/events`. A business change and its versioned domain event are written in the same database transaction, so a committed action cannot lose its follow-up work. PostgreSQL `LISTEN/NOTIFY` wakes consumers immediately; ordered database catch-up remains the recovery path after disconnects or restarts.

Consumers use `FOR UPDATE SKIP LOCKED`, leases, heartbeats, bounded exponential retries, per-consumer receipts and a dead-letter state. Agent runs and long-running website/content work use separate leased job workers so slow AI or provider calls never block the event dispatcher. Records, metrics, approvals, integrations, email/calendar sync, website/content generation, automatic agents, billing, onboarding cleanup and notifications publish or consume domain events.

The agent scheduler does not start every registered specialist. It selects a bounded cross-domain team using connected systems, live workspace data, freshness, failures, rotation pressure and verified performance. See [Agent ecosystem](docs/agent-ecosystem.md).

Authenticated clients can subscribe to `GET /workspaces/:workspaceId/events/stream`. The SSE `id` is the durable global event sequence; reconnect with `Last-Event-ID` to replay missed workspace events in order. Authentication, validation, reads and transaction-local invariants intentionally remain synchronous. Timed work is represented by schedulers that publish durable events instead of performing the business operation in the timer callback.

## Main API routes

All application routes are below `/api/v1`.

| Area | Routes |
| --- | --- |
| API metadata | `GET /`, `GET /resource-types` |
| Auth | `/auth/register`, `/auth/verify-otp`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` |
| Workspaces | `GET/POST /workspaces`, `GET/PATCH /workspaces/:workspaceId` |
| Workspace event stream | `GET /workspaces/:workspaceId/events/stream` |
| Workspace bootstrap | `GET /workspaces/:workspaceId/bootstrap` |
| Members and invitations | `/workspaces/:workspaceId/members`, `POST /workspaces/invitations/:token/accept` |
| Saved views and audit | `/workspaces/:workspaceId/saved-views`, `GET /workspaces/:workspaceId/audit` |
| Billing and prepaid wallets | `GET /workspaces/:workspaceId/billing`, `/workspaces/:workspaceId/api-wallet`, `/workspaces/:workspaceId/adspend` |
| Onboarding | `/workspaces/:workspaceId/onboarding/*` |
| Typed records | `/workspaces/:workspaceId/records/:resourceType` |
| Metrics | `/workspaces/:workspaceId/metrics` |
| Notifications | `/workspaces/:workspaceId/notifications` |
| AI conversations | `/workspaces/:workspaceId/ai/conversations` |
| AI generation | `POST /workspaces/:workspaceId/ai/conversations/:conversationId/respond` |
| Premium product media | `GET/POST /workspaces/:workspaceId/products/:productId/premium-media` |
| Approvals | `/workspaces/:workspaceId/approvals` |

Protected endpoints expect:

```http
Authorization: Bearer <access-token>
```

Responses use a consistent envelope:

```json
{
  "success": true,
  "message": "Record loaded",
  "data": {}
}
```

Errors use stable codes:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed"
  }
}
```

## Resource model

Most product screens use the shared workspace record API. The `resourceType` is validated against `src/domain/resource-catalog.ts`. Domain-specific fields are stored in the `data` JSON object, while common fields such as status, stage, value, currency, dates, assignee, tags and relationships remain queryable columns.

Example:

```http
POST /api/v1/workspaces/<workspaceId>/records/crm_contacts
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Ada Lovelace",
  "status": "active",
  "tags": ["enterprise"],
  "data": {
    "email": "ada@example.com",
    "jobTitle": "VP Growth"
  }
}
```

## AI integration

AI conversation storage works without a provider key. DeepSeek is the default provider:

```dotenv
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
AI_REQUEST_TIMEOUT_MS=180000
AI_MAX_RETRIES=1
```

Set `AI_PROVIDER=alibaba`, `AI_PROVIDER=openai`, or `AI_PROVIDER=groq` with the corresponding provider variables to use another provider. Website generation is processed by a database-backed worker with resumable page checkpoints. No API key is committed to the repository.

## Prepaid execution and storage billing

AI and premium-media execution use a CNY prepaid wallet with fixed customer packages of ¥1,000, ¥2,500, ¥5,000 and ¥9,000, plus a ¥1 payment-test package. Advertising uses a separate prepaid wallet with fixed packages of ¥10,000, ¥25,000, ¥50,000 and ¥90,000, plus a ¥1 payment-test package; Lulu adds a 4% service fee to the charge without reducing the advertising balance. Both wallets support hosted card payments and Airwallex Alipay/WeChat Pay QR payments. Provider callbacks credit each payment exactly once, and refunds or chargebacks cannot be replayed into available funds.

Only Cloudflare R2 storage is PAYG. Lulu does not deduct Cloudflare's free tier. R2 Standard storage and operation rates receive a 10% margin, and storage additionally includes USD 0.20 per GB-month. The worker performs a daily object-inventory reconciliation and creates weekly storage-only invoices; AI execution is never blocked by a storage invoice.

Viewer and Test remain internal-only plans. They are unavailable through public onboarding and require the designated billing administrator; Test additionally requires `BILLING_TEST_PLAN_PASSWORD`. Test and explicitly internal workspaces remain billing-exempt.

## Health endpoints

- `GET /health` checks the API process.
- `GET /ready` checks whether PostgreSQL is configured and reachable.

## Deployment

Set all production environment variables, especially `DATABASE_URL`, `DATABASE_SSL=true`, `JWT_SECRET`, `CORS_ORIGIN`, the configured mail provider variables, and optionally your selected AI provider key. Set `REFRESH_COOKIE_SAME_SITE=none` when the HTTPS frontend and API are hosted on different sites; use `lax` when they share a site. Migrations are serialized with a PostgreSQL advisory lock. Set `RUN_MIGRATIONS_ON_STARTUP=false` only when migrations run in a separate release step.

Use `BACKGROUND_WORKERS_ENABLED=false` on stateless API replicas so they only serve HTTP traffic. Run a separate worker process or worker deployment with `BACKGROUND_WORKERS_ENABLED=true` to handle email and calendar sync, website generation, onboarding cleanup, pay-as-you-go billing, and other background jobs without duplicating work across autoscaled API instances. Cal.com requests use `CALENDAR_CALCOM_ALLOWED_HOSTS`; add an exact self-hosted HTTPS hostname there before connecting it.
