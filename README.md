# Lulu Growth OS Backend

Multi-tenant TypeScript/Express API and PostgreSQL data layer for the Lulu Growth OS frontend.

## Included

- Email/password authentication, OTP verification, refresh-token rotation and password reset
- Workspace isolation with `owner`, `admin`, `member` and `viewer` roles
- Complete onboarding persistence for company data, offerings, platforms and AI preferences
- 98 typed resource categories covering CRM, Sales, Marketing, Advertising, Ecommerce, Finance, Intelligence and AI
- Searchable, paginated records with optimistic version checks, audit history and soft delete
- Metric definitions and time-series points for dashboards and intelligence views
- Notifications, AI conversations, approval requests, background jobs, integration sync runs and webhooks
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

## OpenAI integration

AI conversation storage works without an OpenAI key. Actual response generation requires:

```dotenv
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-terra
```

Provider requests use the Responses API, `store: false`, configured reasoning effort, a privacy-preserving safety identifier, company context and the workspace's AI approval preferences. No API key is committed to the repository.

## Health endpoints

- `GET /health` checks the API process.
- `GET /ready` checks whether PostgreSQL is configured and reachable.

## Deployment

Set all production environment variables, especially `DATABASE_URL`, `DATABASE_SSL=true`, `JWT_SECRET`, `CORS_ORIGIN`, `RESEND_API_KEY` and optionally `OPENAI_API_KEY`. Migrations are serialized with a PostgreSQL advisory lock. Set `RUN_MIGRATIONS_ON_STARTUP=false` only when migrations run in a separate release step.
