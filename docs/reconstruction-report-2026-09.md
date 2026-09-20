# Lulu reconstruction report — 2026-09-20

This is the required initial reconstruction output for the existing platform.
It is evidence-led and deliberately distinguishes implemented behavior from
partial provider or operational verification.

## A–B. Repository and current architecture

- Backend: Express 5, TypeScript, PostgreSQL/`pg`, ordered migrations, typed
  repositories, REST API, SSE event stream, durable PostgreSQL event runtime,
  leased workers and provider control plane.
- Frontend: React 19, TypeScript, Vite, React Router, typed API clients,
  canonical Workspace pages plus generated compatibility page catalog and the
  Virtual Office view.
- Backend source: approximately 342 TypeScript files under domain-oriented
  modules. Database: 131 migrations and approximately 228 table definitions.
- Runtime path: request/webhook/schedule → authenticated workspace context →
  service/repository transaction → domain event → leased worker/agent run →
  policy/provider/quality gate → verified result or bounded recovery.

## C–D. Feature and domain inventory

The live capability matrix is maintained in
`docs/autonomous-company-os-audit.md`. The current domains include auth,
workspaces/RBAC, onboarding/company brain, typed records, CRM/company
intelligence, sales, commerce/catalog/inventory/orders, commercial documents,
finance/ledger, AI/agents/tools/quality, wallets/billing/payments, websites,
domains, media, email/calendar/OmniChannel, advertising, social, integrations,
provider control, notifications, audit, analytics, admin and durable events.

Most high-value features already have a canonical service, repository,
workspace permission, event or worker. Provider mutation paths are intentionally
classified as `PARTIAL` until live tenant evidence proves the external side
effect. Catalog metadata is not treated as connectivity.

## E. Largest files and decomposition risk

The largest cohesive backend files are currently:

```text
modules/billing/airwallex.service.ts       ~2,174 lines
modules/commerce/commerce.repo.ts          ~2,023 lines
modules/admin/admin.repo.ts                ~1,966 lines
modules/agents/agent-execution.worker.ts   ~1,483 lines
modules/agents/agent.registry.generated.ts ~3,193 lines (generated)
modules/provider-control/provider.repo.ts  ~983 lines
```

These are refactor candidates, not safe targets for blind splitting. Each
needs characterization tests and a parity map before extraction.

## F. Database audit

- Strong areas: ordered migrations, tenant foreign keys in major domains,
  explicit wallet/ledger/reservation tables, idempotency keys, event receipts,
  provider operation records and operational audit history.
- Risks: the schema is broad and still contains compatibility/generic-record
  surfaces; JSONB usage must remain bounded and core entities must not fork;
  PostgreSQL RLS is not currently enabled; index/query efficiency needs live
  plans and `pg_stat_statements` evidence.
- Growth tables requiring retention/archival plans: domain events, agent runs,
  webhooks, messages, audit, provider payloads, sync attempts and media jobs.
- No migration should merge user/contact/customer/company/workspace concepts
  without a documented semantic decision.

## G. Performance audit

Likely risks are broad admin/commerce/billing queries, generated pages that may
load too much related state, event/audit histories, generic records and
provider payloads. The correct next step is request tracing and representative
dataset plans—not speculative Redis or mass index creation. `PERFORMANCE.md`
defines the measurement and acceptance method.

## H. Security and tenancy audit

The current boundary is authenticated workspace membership plus capability
authorization. High-risk workflows have server-side permission, budget,
idempotency, provider readiness and quality gates. Remaining defence-in-depth
work is RLS evaluation, provider live mutation proof, backup/restore drills,
secret rotation and jurisdiction-specific compliance review. Do not weaken the
existing fail-closed behavior to make an integration appear connected.

## I. Technical debt priority

**Critical:** any tenant leak, financial double-credit, unverified provider
side effect, auth bypass, uncontrolled autonomous spend, or migration that can
destroy customer records.

**High:** unbounded high-growth lists, N+1 dashboard paths, long transactions
around provider calls, ambiguous retries that repeat side effects, missing
provider live verification, and missing backup/restore proof.

**Medium:** oversized cohesive services, duplicated generated UI surfaces,
incomplete provider mutation coverage, and incomplete frontend lazy loading.

**Low:** cosmetic naming, generated-file size, and non-critical documentation
gaps that do not change ownership or runtime behavior.

## J–K. Target architecture and data model

Keep domain-oriented services with one canonical owner per business concept.
Use typed API DTOs, repositories for SQL, services for use cases, a provider
adapter boundary, versioned domain events, leased jobs, immutable financial
evidence and Office projections over real work. Keep flexible JSONB at provider,
event and AI edges only. Use explicit composite tenant indexes and keyset
pagination for growth tables.

## L. Safe migration strategy

Characterize current behavior first. Add forward-compatible schema changes,
backfill in batches, dual-read only when required, switch callers, verify
counts/constraints/query plans, observe a release window, then remove legacy
paths. Never replace a working billing, auth, provider or autonomous workflow
from memory. Every step must pass typecheck, migration verification, tests,
build and smoke checks.

## M. Implementation sequence

1. Keep this inventory and the machine-readable audit current.
2. Measure critical endpoint/request/query baselines on realistic data.
3. Add characterization/security/tenant tests for high-risk workflows.
4. Fix bounded pagination, N+1 queries and oversized payloads first.
5. Extract cohesive billing/provider/agent subservices behind existing APIs.
6. Add only justified schema/index changes with backfill and rollback plans.
7. Prove provider mutations and webhook recovery in opt-in live gates.
8. Migrate frontend lists to lazy, paginated canonical pages.
9. Remove legacy paths only after parity evidence.
10. Repeat architecture, security, performance and repository audits before
    declaring a release complete.

