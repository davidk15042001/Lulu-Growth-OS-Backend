# Lulu Growth OS Backend

Multi-tenant TypeScript/Express API and PostgreSQL data layer for the Lulu Growth OS frontend.

## Included

- Email/password authentication, OTP verification, refresh-token rotation and password reset
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

## Main API routes

All application routes are below `/api/v1`.

| Area | Routes |
| --- | --- |
| API metadata | `GET /`, `GET /resource-types` |
| Auth | `/auth/register`, `/auth/verify-otp`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` |
| Workspaces | `GET/POST /workspaces`, `GET/PATCH /workspaces/:workspaceId` |
| Workspace bootstrap | `GET /workspaces/:workspaceId/bootstrap` |
| Members and invitations | `/workspaces/:workspaceId/members`, `POST /workspaces/invitations/:token/accept` |
| Saved views and audit | `/workspaces/:workspaceId/saved-views`, `GET /workspaces/:workspaceId/audit` |
| Billing and integration sync | `GET /workspaces/:workspaceId/billing`, `POST /workspaces/:workspaceId/integrations/:platformId/sync` |
| Onboarding | `/workspaces/:workspaceId/onboarding/*` |
| Typed records | `/workspaces/:workspaceId/records/:resourceType` |
| Metrics | `/workspaces/:workspaceId/metrics` |
| Notifications | `/workspaces/:workspaceId/notifications` |
| AI conversations | `/workspaces/:workspaceId/ai/conversations` |
| AI generation | `POST /workspaces/:workspaceId/ai/conversations/:conversationId/respond` |
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

AI conversation storage works without a provider key. Alibaba DashScope is the default provider:

```dotenv
AI_PROVIDER=alibaba
DASHSCOPE_API_KEY=...
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.7-plus
AI_REQUEST_TIMEOUT_MS=180000
AI_MAX_RETRIES=1
```

Set `AI_PROVIDER=openai` with `OPENAI_API_KEY` and `OPENAI_MODEL=gpt-5-mini`, or `AI_PROVIDER=groq` with the corresponding Groq variables, to use another provider. Website generation is processed by a database-backed worker with resumable page checkpoints. No API key is committed to the repository.

## Health endpoints

- `GET /health` checks the API process.
- `GET /ready` checks whether PostgreSQL is configured and reachable.

## Deployment

Set all production environment variables, especially `DATABASE_URL`, `DATABASE_SSL=true`, `JWT_SECRET`, `CORS_ORIGIN`, `RESEND_API_KEY` and optionally `OPENAI_API_KEY`. Set `REFRESH_COOKIE_SAME_SITE=none` when the HTTPS frontend and API are hosted on different sites; use `lax` when they share a site. Migrations are serialized with a PostgreSQL advisory lock. Set `RUN_MIGRATIONS_ON_STARTUP=false` only when migrations run in a separate release step.
