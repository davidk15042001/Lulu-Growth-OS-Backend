# Lulu Growth OS architecture

## System shape

Lulu is a multi-tenant Express/TypeScript API with PostgreSQL persistence and
a React/TypeScript frontend. Workspace and Office are two views over the same
domain services, events, permissions, records and audit history. The Office's
Digital Employees are role-level projections over multiple specialist agents,
tools, workflows and provider adapters; they are not fake background activity.

The durable path is:

```text
HTTP / webhook / schedule / provider signal
  -> authenticated workspace context
  -> application service + transaction
  -> canonical domain mutation + audit
  -> versioned domain event
  -> leased worker / agent run / action packet
  -> policy, budget, provider and quality gates
  -> verified outcome, retry or dead letter
  -> Office projection + Workspace API
```

## Repository boundaries

- `src/modules/auth`, `users`, `workspaces`, `entitlements`, `approvals`:
  identity, tenancy and permissions.
- `src/modules/records`, `crm-company`, `sales-pipeline`, `commerce`,
  `commercial-documents`, `finance`: canonical business objects and ledgers.
- `src/modules/agents`, `office`, `company-brain`, `quality`: autonomous
  planning, Digital Employee projection, evidence, execution and review.
- `src/modules/provider-control` and provider/domain adapters: stable
  tenant-scoped integration boundary and readiness evidence.
- `src/events`, `operations`, worker modules and `background_jobs`: durable
  event delivery, leasing, retries, heartbeats and dead letters.
- `src/modules/ai`, `premium-media`, `research`, `content-generation`: bounded
  model/provider work with prepaid reservations where applicable.
- `src/modules/composio`: tenant-scoped Composio connection, tool execution and
  trigger webhook boundary. Tool calls and accepted trigger events are charged
  from the existing prepaid AI wallet before external work is accepted.
- `src/modules/onboarding`, `websites`, `storefront`, `omnichannel`,
  `calendar`, `email`, `notifications`: customer-facing operational domains.

## Dependency direction

```text
routes/controllers -> application services -> repositories -> db/pool
                                  |-> domain events
                                  |-> provider adapters
                                  |-> policy/permissions
workers/events -> application services (never UI)
frontend -> typed API clients -> HTTP API (never database)
```

Repositories own SQL. Services own cross-entity workflows and invariants.
Provider adapters translate external identifiers and payloads; canonical
records remain authoritative. Generic `workspace_records` is intentionally a
compatibility and flexible-record boundary, not permission to create a second
source of truth for products, orders, invoices, or customers.

## Autonomous execution

Agent definitions are registered in `agent.ecosystem.ts` and selected through
bounded team planning. Execution commands are server-owned and carry tenant,
capability, risk, budget and idempotency policy. Provider work is not
considered complete merely because a request was queued: workers must record a
verified terminal state or an explicit ambiguous/dead-letter state.

The initial post-onboarding analysis is a read-only observe/understand/
diagnose phase. It stores company brain, audience, competitor, funnel,
financial, creative, integration, compliance and measurement sections plus
actual metric evidence. It does not publish, message customers or spend funds.

## Known boundaries and target improvements

- The current application has 137 migrations and approximately 236 relational
  tables. The existing `docs/autonomous-company-os-audit.md` is the source-led
  capability matrix and production release evidence.
- PostgreSQL row-level security is not currently the tenant boundary; service
  authorization and workspace-scoped queries are. RLS is a separate,
  migration-safe defence-in-depth project, not a reason to bypass current
  authorization.
- Several billing, provider, commerce and agent files are intentionally large
  cohesive units. Decompose them only behind characterization tests and a
  functional-parity matrix.
- Generated frontend pages remain compatibility surfaces. New autonomous
  mutations must use canonical backend commands and domain services, not add
  business logic to generated React files.

## Critical invariants

1. A workspace can never read or mutate another workspace's data.
2. A wallet reservation is not settled credit; pending/ambiguous payments and
   provider work remain held until verified reconciliation.
3. Advertising balance is funding, not campaign authorization.
4. Manual and autonomous paths produce the same canonical business object.
5. Every visible Office work state maps to persisted work, an event, a run step,
   an action packet, or a provider operation.
6. Failed or blocked work must stop or enter a bounded retry/dead-letter path;
   it must not silently repeat expensive AI/provider calls.
7. Composio execution is only accepted through the server-side metered route;
   the workspace session endpoint never exposes an unmetered MCP transport.
