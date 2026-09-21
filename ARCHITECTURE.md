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
- `src/modules/agents`, `office`, `company-brain`, `executive-ops`, `quality`:
  autonomous planning, Digital Employee projection, evidence, executive
  operating cycles, execution and review.
- `src/modules/provider-control` and provider/domain adapters: stable
  tenant-scoped integration boundary and readiness evidence.
- `src/events`, `operations`, worker modules and `background_jobs`: durable
  event delivery, leasing, retries, heartbeats and dead letters.
- `src/modules/ai`, `premium-media`, `research`, `content-generation`: bounded
  model/provider work with prepaid reservations where applicable.
- `src/modules/composio`: tenant-scoped Composio connection, governed catalog,
  tool execution and trigger webhook boundary. The full catalog is admin-only;
  customer workspaces receive only non-managed toolkits published in the
  catalog. Tool calls and accepted trigger events are charged from the existing
  prepaid AI wallet before external work is accepted.
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

Each persisted agent run also owns one tenant-scoped collaboration thread.
Planning, evidence, specialist handoffs, proposals, verification and terminal
outcomes are immutable, idempotent messages linked to the real run and, where
present, its Company Brain task. The next reasoning step reads this bounded
ledger as untrusted evidence. Zep mirrors the same thread for long-term
memory. Mirroring has a local sync acknowledgement and retries only messages
that have not been acknowledged. Zep is advisory only: Lulu's PostgreSQL
collaboration ledger, canonical domain services and action packets remain
authoritative.

Zep users are workspace-scoped (`workspace:<workspaceId>:user:<userId>`), so
memory cannot bridge tenant boundaries. Chat and agent reasoning retrieve only
bounded, explicitly untrusted user memory. The standalone organization graph
is queried separately for platform-owned policies and product facts; no
workspace/customer data is written there. Its results are also untrusted and
never confer permissions, funding, provider readiness, or execution evidence.

The initial post-onboarding analysis is a read-only observe/understand/
diagnose phase. It stores company brain, audience, competitor, funnel,
financial, creative, integration, compliance and measurement sections plus
actual metric evidence. It does not publish, message customers or spend funds.

The Executive Operating System adds durable daily and weekly loops above the
same canonical services. A leased worker initializes schedules only for
automation-eligible workspaces, claims a workspace-scoped lease, and records a
time-bounded data cutoff for every cycle. Each cycle reads bounded canonical
facts such as open Company Brain signals, blocked tasks, failed agent runs,
overdue invoices grouped by currency, overdue canonical CRM/Sales follow-ups,
stalled canonical opportunities, and usable metric history. Missing inputs
are persisted as data gaps rather than being filled with invented conclusions.
Timestamped fact queries receive that stored cutoff and exclude later input, so
the persisted report cannot silently absorb a concurrent metric point or run
state that arrived after the review began.

Forecasts use an explicitly labelled, transparent two-point trend model until a
stronger model earns its own evidence and calibration contract. Low/base/high
values and scenario sensitivity calculations are stored as PostgreSQL `NUMERIC`;
scenarios never overwrite a canonical metric or financial record. When the
first later metric point becomes available, forecast calibration is appended as
verified learning evidence. The forecast range stays ordered for both rising
and falling trends. Material measured declines in product and marketing/
acquisition metrics create product or campaign risk findings, never a causal
claim or direct business mutation. CRM risk findings derive only from overdue
canonical follow-ups or opportunities without a canonical update for the
documented aging window; they are workflow-age evidence, not close predictions.

Executive proposals are always `plan_only` and require an explicit human
decision. Approval rechecks the proposal's domain capability and automation
state, then creates a Company Brain observation, signal, and plan-only mission.
It does not directly publish, send, spend, alter a CRM record, or bypass the
existing provider, funding, attribution, settlement, or compliance gates. The
Company Brain worker remains the only canonical route from an approved plan to
Digital Employee work. The proposal type selects a deterministic, persisted
specialist team, such as Product Manager plus Commerce Analytics for product
work, Marketing Manager, Paid Acquisition, Policy, and Quality for campaigns,
or CRM Manager, Customer Manager, and Quality for CRM recovery plans.
Each specialist receives only plan-only objectives and bounded untrusted
evidence. A dispatched proposal becomes `completed` only after its Company
Brain mission is completed and a user with both the proposal-domain capability
and `quality.review` appends an evidence-bearing, idempotent outcome review.

## Known boundaries and target improvements

- The current application has 149 migrations and approximately 249 relational
  table definitions. The existing `docs/autonomous-company-os-audit.md` is the source-led
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
   Lulu platform admins with `billing.bypass` are explicitly exempt from the
   customer charge and billable wallet debit, while ordinary workspace admins
   are still metered;
   the workspace session endpoint never exposes an unmetered MCP transport.
8. Composio customer availability is enforced by the backend catalog registry;
   the frontend may present the published list but cannot grant provider access.
   The technical raw tool list is restricted to platform administrators.
