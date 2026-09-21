# Lulu Growth OS performance guide

## Baseline status

This repository has a large PostgreSQL-backed surface and a durable worker
runtime. The current audit found the following likely engineering hotspots;
they are priorities, not claims of measured production latency:

| Area | Evidence | Risk |
| --- | --- | --- |
| Billing/Airwallex service | ~2,174 lines | provider/payment paths are hard to profile and change safely |
| Admin repository | ~1,966 lines | broad admin joins can over-fetch customer data |
| Commerce repository | ~2,023 lines | catalog/order lists can become expensive with growth |
| Agent execution worker | ~1,483 lines | long work, retries and provider calls must not hold DB transactions |
| Executive operating worker | scheduled cross-domain reads | daily/weekly cycles must use bounded facts, per-workspace leases and no provider calls in their transaction |
| Agent registry | generated ~3,193 lines | generated data should stay separate from orchestration logic |
| Provider repository | ~983 lines | readiness/discovery payloads need bounded detail/list separation |
| Premium media and website services | >800–1,300 lines | long-running AI/media operations belong in leased workers |

The initial analysis deliberately bounds `workspace_records` to 600 rows and
loads only selected onboarding context. This is safe as a bounded analysis
input, but future list/detail APIs must use pagination and must not copy this
pattern for arbitrary customer collections.

## Measurement method

For any critical interaction record:

```text
browser request count and render time
HTTP latency and payload size
controller/service duration
SQL query count and total DB time
EXPLAIN (ANALYZE, BUFFERS) for the slow query
external provider latency and retry count
```

Use representative workspace data, not a tiny empty database. Compare p50/p95
and p99 for list, detail, dashboard, event-stream and worker paths. Do not add
cache or rewrite SQL before locating the slow layer.

## Guardrails

- Every list endpoint has a bounded default and maximum page size.
- Prefer keyset cursors `(created_at, id)` for high-growth event, message,
  audit, agent-run, webhook and invoice lists.
- Batch related counts and records; eliminate per-row repository calls.
- Executive operating cycles retrieve bounded cross-domain facts, group financial
  evidence by currency, apply the cycle data cutoff to timestamped facts, and
  never wait for AI or providers while a cycle or schedule lease transaction is
  open. Declining product/campaign metric scans are bounded by workspace and
  metric count; CRM/Sales risk scans are limited to indexed canonical follow-up
  and opportunity resource types, then delegate plan-only work through Company
  Brain.
- Do not return provider payloads, AI output blobs or audit metadata in list
  responses unless explicitly requested.
- Avoid repeated frontend requests: use one bootstrap query, cache only with a
  stated tenant-safe key/TTL/invalidation policy, and lazy-load tabs.
- Use short DB transactions. Never wait for OpenAI, Kie, Airwallex, Google,
  Meta, WhatsApp, email or media providers while holding a transaction.
- Monitor pool wait time, event queue depth, worker heartbeat age, retry/dead
  letter counts, AI reservation holds and provider rate-limit state.

## Acceptance budgets (targets to measure, not current claims)

- Authenticated lightweight read: p95 under 300 ms excluding provider calls.
- Paginated workspace list: p95 under 500 ms with a bounded payload.
- Detail page with lazy related data: p95 under 800 ms excluding provider calls.
- Event/worker enqueue: local commit and response under 300 ms; work executes
  asynchronously.
- Provider/AI work: measured separately; never block the request indefinitely.

Any target that is missed should produce a trace and query plan before a fix is
selected. Keep a before/after note in the change or the release record.
