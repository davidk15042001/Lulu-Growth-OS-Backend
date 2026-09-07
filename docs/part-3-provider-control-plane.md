# Part 3 — Provider Control Plane

This document records the Provider Control Plane foundation. It is deliberately
provider-neutral: existing OAuth and integration flows remain the operational
compatibility layer, while canonical provider records provide a single place for
mode, account, asset, capability, health, sync and mapping state.

## Canonical flow

`Lulu domain → Provider Control Plane → Provider adapter → external provider`

Legacy records are backfilled into `provider_connections` with a stable
`source_type/source_id` reference. Credentials stay in the existing encrypted
credential stores; the control plane stores only a non-secret credential
reference. This makes the migration restart-safe and avoids copying tokens.

## Data model

- `provider_registry` and `provider_capability_definitions` describe known
  providers and the capabilities Lulu can truthfully report.
- `provider_connections` stores scope (`WORKSPACE`, `ORGANIZATION`,
  `LULU_PLATFORM`, `PARTNER`), mode, authorization state, health and source
  references.
- `provider_accounts` and `provider_assets` represent external containers and
  resources without provider-specific tables.
- `provider_capability_states` records the effective, connection-level status.
- `provider_object_mappings` maps canonical Lulu objects to external objects and
  records source-of-truth policy.
- `provider_sync_states`, `provider_operations` and
  `provider_webhook_events` provide shared sync, idempotency and webhook state.

## Security boundaries

Workspace API methods require an explicit workspace context and use workspace
scoped queries. Mapping and provider-operation creation validates that the
connection is owned by, or explicitly shared with, that workspace and that
account/asset references belong to the connection. Webhooks require a
configured HMAC secret, reject stale timestamps, enforce constant-time
signature comparison, validate connection/account ownership, and deduplicate
by `(provider_key, external_event_id)`. Verified events are persisted as
`RECEIVED` and processed by a durable worker with bounded retries and a
`DEAD_LETTER` state. Airwallex continues to use its existing billing webhook
verifier.

The database migration intentionally does not enable PostgreSQL RLS; the current
pool/worker architecture keeps application authorization as the active control
and RLS remains a staged defense-in-depth option.

## Adapter and capability policy

`ProviderAdapter` supplies a common verification/discovery/capability/health/sync
contract. The current conservative adapter never claims a live provider probe
that has not happened. Unsupported or provider-review capabilities therefore
remain `UNCONFIRMED`, `PROVIDER_REVIEW` or `UNAVAILABLE`, rather than appearing
operational in the UI.

## Compatibility

OAuth callbacks for workspace platforms, admin-managed OAuth, Gmail/Microsoft/
IMAP email and Google/Microsoft calendar now upsert or synchronize canonical
provider records while preserving their existing tables and service behavior.
The existing integrations UI shows the canonical status, mode, health,
capabilities and discovered accounts/assets and exposes only guarded actions.

## Worker hardening

Provider sync requests are serialized per connection and sync type, so
repeated clicks return the existing queued/running job instead of creating
duplicates. Sync and webhook workers use PostgreSQL leases, heartbeats,
exponential backoff and explicit terminal failures. A provider without a real
sync/webhook adapter is marked `PAUSED`/`IGNORED`; no provider capability is
reported as live merely because a token exists.

The migration adds database triggers for capability/sync subject integrity and
access-aware checks for shared connections. Existing legacy rows remain
non-destructively auditable; PostgreSQL RLS is still deferred because pooled
HTTP requests, admin actions and background workers do not yet establish a
transaction-scoped tenant context consistently.
