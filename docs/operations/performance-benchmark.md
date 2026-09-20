# Performance benchmark protocol

Performance measurements must run against an isolated, production-like database. Never point a synthetic load at a customer or production database by accident.

## Dataset tiers

Use deterministic fixtures with at least these tiers:

- small: 10 workspaces, 10k records, 1k events;
- medium: 100 workspaces, 1m records, 100k events;
- large: 1k workspaces, 10m records, 1m events;
- very large: a representative production snapshot with secrets and personal data removed.

For each tier measure p50, p95, p99 latency, rows read, shared buffers hit/read, lock waits, queue lag, and error rate for tenant lists, search, dashboards, worker claims, provider webhooks, and exports.

## Safe execution rules

Use a separate `PERFORMANCE_DATABASE_URL`. The harness must refuse a URL whose host is the production host unless `ALLOW_PERFORMANCE_DATABASE=1` is explicitly set by an operator. Store plans and results as build artifacts; do not commit customer data.

The review output must include `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for every query that exceeds its latency or row-read budget. A benchmark without a plan and a dataset identifier is not a regression baseline.

