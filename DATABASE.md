# Lulu Growth OS database guide

## Current inventory

The migration directory currently contains 149 ordered migrations, about 249
table definitions and 369 declared indexes (counts from the read-only
architecture audit; generated/provider-specific SQL may change the exact live
catalog). The schema is PostgreSQL-first and migrations are serialized with an
advisory deployment lock.

## Canonical ownership

- `users`, `auth_sessions`, refresh/OTP tables own identity and sessions.
- `workspaces`, `workspace_members`, settings, subscriptions and capabilities
  own tenant membership, activation and entitlements.
- `workspace_records` is a bounded, typed flexible-record surface. Canonical
  modules own high-value entities: products/variants, commerce orders and
  inventory, quotes/invoices, finance journals, conversations/messages,
  websites/domains, provider connections and agent work.
- `workspace_api_wallets` and `workspace_ad_spend_wallets` are separate
  financial authorities. Their ledgers, reservations and payment lifecycle
  tables are append-only/idempotent evidence, not display-only counters.
- `workspace_composio_usage_ledger` owns the fixed-price Composio meter. Each
  row is tenant-scoped, idempotent and linked to one negative entry in the AI
  wallet ledger; new `TOOL_CALL` and `TRIGGER` rows cost `1.000000 CNY`.
- `domain_events`, receipts, jobs, agent runs/steps/action packets and audit
  tables own operational history and recovery state.
- `executive_operating_schedules`, `executive_operating_cycles`, findings,
  forecasts, scenarios, proposal events and learning records own the Executive
  Operating System's tenant-scoped evidence. Cycles retain their data cutoff and
  gaps; forecasts/scenarios use `NUMERIC` values; proposals are plan-only and
  their append-only events record human decisions and Company Brain hand-off.
  Measured product/campaign metric declines and bounded canonical CRM/Sales
  follow-up and opportunity aging scans become workspace-scoped findings;
  outcome reviews append a verified learning record only after the linked
  Company Brain mission completes, with optimistic proposal versioning and an
  idempotency key.
- Provider tables store external references, capability/readiness evidence and
  redacted payload snapshots. They do not replace canonical Lulu entities.

## Tenant and relationship rules

Every tenant-owned table must have an explicit `workspace_id` (directly or by
an unambiguous foreign-key chain), a foreign key to the owning workspace where
possible, and an index beginning with the tenant key for common list queries.
Use composite uniqueness for external/provider identifiers, for example
`(workspace_id, provider, external_id)`. Avoid global uniqueness for tenant
data unless it is truly global.

Do not merge users, contacts, leads, customers, companies, organizations and
workspaces without first documenting their business semantics. Provider
customers/accounts are mapped references, not independent Lulu sources of
truth.

## JSONB policy

Allowed: webhook/provider payload snapshots, event payloads, AI execution
metadata, flexible integration configuration and low-criticality custom fields.
Core searchable/financial/state fields must be typed columns with constraints.
When a JSONB attribute becomes queried, sorted, authorized or financially
material, promote it to a relational column or an intentional generated/indexed
representation.

## Query and index rules

- No unbounded user-facing list query. Use deterministic cursor/keyset
  pagination for rapidly growing data and return a bounded page size.
- Never use `SELECT *` for high-volume API paths; omit large JSON/provider
  payloads from list responses.
- List and detail queries are separate. Related histories, metrics and
  provider payloads load on demand.
- For `WHERE workspace_id = $1 ORDER BY created_at DESC`, consider the actual
  `(workspace_id, created_at DESC, id DESC)` access pattern and verify with
  `EXPLAIN (ANALYZE, BUFFERS)` before adding an index.
- Every new foreign key and frequent filter needs an index review. Do not add
  duplicate or speculative indexes.
- Keep long AI/provider calls outside database transactions. Transactions
  protect local invariants only.

## Financial and destructive changes

Money uses precise `NUMERIC` values and explicit currency. Historical ledger
entries, paid invoices, webhook evidence and provider operation outcomes are
not casually overwritten. Refunds, chargebacks, reversals and ambiguous
provider outcomes are modeled as new evidence and reconciliation transitions.

Destructive cleanup requires an explicit scope, a recoverable migration or
backup/restore plan, row-count checks and a reviewed rollback strategy. Never
truncate production data as a shortcut for a migration or test.

## Migration workflow

1. Check existing tables, indexes, constraints and repository usage.
2. Add a forward-only migration with explicit constraints and indexes.
3. Make it safe from zero and from the current production head.
4. Backfill in bounded batches with progress and resumability.
5. Deploy code that can read old and new state during the transition.
6. Verify counts, foreign keys, tenant isolation and query plans.
7. Remove legacy structures only after functional parity and a release window.
