# Lulu Growth OS — instructions for coding agents

This repository is the production backend for Lulu. It is a multi-tenant
Express/TypeScript API backed by PostgreSQL. The frontend lives in the sibling
`Lulu-Growth-OS-Frontend` repository. Read `ARCHITECTURE.md`, `DATABASE.md`,
`PERFORMANCE.md`, and `docs/autonomous-company-os-audit.md` before changing a
cross-domain workflow.

## Non-negotiable rules

- `workspace_id` is the tenant boundary. Every read, write, event, job,
  provider operation, and audit entry must be workspace-scoped.
- Enforce capabilities server-side with the existing workspace middleware and
  permission registry. Frontend checks are only presentation.
- Put HTTP parsing in controllers, business rules in application services,
  and SQL in repositories. Do not add SQL to routes or React components.
- Manual Workspace actions and autonomous Digital Employee actions must call
  the same canonical domain service. Never create a second “office” data path.
- Provider calls go through the provider control plane or a domain adapter.
  Never leak provider-specific payloads into canonical business entities.
- Financial values use PostgreSQL `NUMERIC`/the existing ledger conventions;
  never use JavaScript floating point for money. Preserve immutable ledger and
  idempotency semantics.
- AI/provider work must be bounded, tenant-aware, retry-safe, observable and
  fail closed when permissions, funding, attribution, settlement or compliance
  evidence is missing.
- Persisted work must be represented by domain events, agent runs, work items,
  action packets, audits, or provider operation records. UI animation is never
  evidence of work.
- Growing collections require bounded retrieval and deterministic pagination.
  Avoid `SELECT *`, unbounded `workspace_records` reads, and N+1 queries.
- JSONB is for provider snapshots, event payloads, AI metadata, and flexible
  low-criticality configuration. Core business fields remain relational.
- Add migrations only after checking the existing schema and canonical owner.
  Migrations must work from zero and from the current production head and must
  not delete customer data without an explicit, reviewed migration plan.
- Do not log passwords, tokens, private keys, card data, or raw provider
  secrets. Errors exposed to clients must use stable safe error codes.

## Required verification

Backend changes normally require:

```text
npm run typecheck
npm test
npm run test:migrations
npm run build
npm run audit:architecture
```

For frontend changes also run the frontend `npm run check`. For changes to
payments, wallets, invoices, webhooks, authentication, provider adapters,
tenant isolation, or autonomous execution, add or update a regression test and
run the relevant live-readiness gate only when explicitly authorised.

## Change discipline

1. Inspect callers, schema, migrations, permissions, events and tests first.
2. Define the canonical owner and data flow before adding a table or endpoint.
3. Make the smallest cohesive change; do not mass-rewrite generated pages.
4. Keep long AI/provider work out of request transactions.
5. Make retries and external side effects idempotent and preserve ambiguous
   outcomes for reconciliation instead of automatically repeating them.
6. Update the architecture/audit documentation when boundaries change.

