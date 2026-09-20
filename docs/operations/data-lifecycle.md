# Data lifecycle operations

Migration `0130_data_lifecycle_controls.sql` adds explicit retention policies, legal holds, and auditable retention runs. Policies are disabled by default. This is intentional: retention and deletion are legal/business decisions, not an automatic side effect of deployment.

## Audit first

```bash
RETENTION_DATABASE_URL='postgresql://…/isolated-or-production' \
RETENTION_WORKSPACE_ID='<workspace uuid>' \
npm run retention:audit
```

The audit is read-only. It reports candidate rows, timestamp ranges, enabled state, disposition, and active legal holds.

## Execute a reviewed deletion

Only the explicitly supported tenant-scoped tables can be deleted by the executor (`onboarding_documents`, `domain_events`, and `agent_run_events`). Archive, anonymize, audit, financial-ledger, and provider-webhook policies are review-only until a separate archive destination and legal approval exist.

```bash
RETENTION_DATABASE_URL='postgresql://…' \
RETENTION_POLICY_ID='<reviewed policy uuid>' \
RETENTION_WORKSPACE_ID='<workspace uuid>' \
RETENTION_APPLY=1 \
RETENTION_DRY_RUN=1 \
npm run retention:execute
```

The default is dry-run. A real delete requires `RETENTION_DRY_RUN=0`, an enabled `DELETE` policy, a tenant workspace ID, a reviewed policy ID, and an explicit idempotency key when an operator needs a repeatable run. Active legal holds are excluded and the run is persisted in `data_retention_runs`.

No retention command deletes financial ledger rows or bypasses the ledger append-only trigger.

