# Production hardening status (rules 110–152)

This document is the implementation register for the additional production-grade reconstruction rules. It deliberately distinguishes controls that are executable today from controls that still require production infrastructure, workload data, or an explicit business decision.

## Implemented and checked in this repository

| Rules | Control | Evidence |
| --- | --- | --- |
| 110–111 | Architecture inventory and schema contracts are executable checks | `npm run audit:architecture`, `npm run test:schema-contracts` |
| 119 | Migrations are ordered, additive-first, and exercised against PGlite | `scripts/verify-migrations.ts`, migration test suite |
| 121, 123 | Transaction helpers, idempotency keys, unique business keys, and optimistic versions exist in the canonical write paths | `src/db/pool.ts`, `idempotency_keys`, document and ledger constraints |
| 124–126 | Durable versioned domain events, delivery claims, receipts, attempts, dead-letter state, and replay-safe consumer keys | `domain_events`, `domain_event_receipts`, `src/events` |
| 127–131 | Worker leases, provider rate-limit state, wallet reservations, cost guards, and bounded request rate limiting are represented in the runtime | agent/provider-control/billing modules and related tests |
| 132–136 | Secret references are separated from provider metadata; ledger mutation is append-only; dependency audit runs in CI | provider control-plane migrations, finance hardening migration, GitHub workflow |
| 137–138 | Frontend API-contract audit and backend resource catalog prevent accidental UI/API drift | frontend `scripts/audit-api-contracts.mjs`, `src/domain/resource-catalog.ts` |
| 147 | Request IDs and event correlation IDs are persisted through HTTP, logs, and durable events | request middleware, `domain_events.metadata`, audit records |
| 150–152 | Release/check commands provide a repeatable definition-of-done gate | `package.json` `check` script and this register |

## Partial or requires an environment decision

### Query performance and growth (112–116, 142–146)

The schema has tenant-first indexes and the application uses bounded pagination in the canonical list APIs. A complete query-regression program still needs production-like data volumes and captured `EXPLAIN (ANALYZE, BUFFERS)` plans for the top workload queries. Large exports, virtualization, and memory budgets must be verified per frontend surface rather than inferred from source code.

The required operating model is:

1. Generate synthetic small/medium/large datasets in an isolated database.
2. Capture plans and latency percentiles for every high-volume list, search, dashboard, worker claim, and export query.
3. Store a baseline and fail CI when a reviewed query regresses beyond its budget.
4. Keep hot rows in the primary tables, move warm history to partitioned/archive storage, and delete only after retention and legal holds permit it.

Retention must be configured per data class (audit, financial ledger, messages, provider webhooks, AI traces, onboarding files, and analytics). No deletion job may run without a legal-hold and tenant-scope check.

### Backups, restore, and disaster recovery (117–118)

The repository contains [database-backup-restore.md](operations/database-backup-restore.md) and verification scripts. A production operator must still schedule encrypted backups, copy them to an independent failure domain, and run a restore drill. The proposed initial objectives are RPO 15 minutes and RTO 60 minutes; these are targets until the restore drill measures them.

### Zero-downtime release and rollout (120, 139–141)

Migrations follow expand/contract rules and the release manifest makes the deployed backend/frontend pair observable. A full canary, automated rollback threshold, and multi-version compatibility window are not yet implemented. Do not treat a green build as a canary result.

### Observability and SLOs (148–149)

Correlation IDs and structured logs are present. A live database dashboard, queue-lag alerting, provider error-rate alerting, and published SLO/error-budget policy still need deployment-specific telemetry and alert destinations.

## Review policy

`npm run audit:architecture` is intentionally non-blocking for existing debt such as a legacy `SELECT *`, a controller query, or a large file. It records these as review findings. Set `ARCHITECTURE_AUDIT_STRICT=1` in a controlled CI job to fail on new blocking architecture violations, including frontend imports of backend source/build output.

Every change is complete only when:

- schema contracts and migrations pass;
- the affected API and UI contract tests pass;
- idempotency, retry, concurrency, and authorization paths are tested;
- query plans and retention impact are reviewed for new high-volume data;
- logs contain request/event correlation and sensitive data is redacted;
- rollback and restore procedures are documented for the release;
- a real staging or production smoke test confirms the deployed version.

