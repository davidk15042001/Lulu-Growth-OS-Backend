# Composio setup

Composio is connected with a stable identity in the form
`lulu:<workspace_id>:<user_id>`. Credentials remain with Composio; Lulu stores
only connection state and the identifiers needed for the tenant-scoped flow.

## Metering

The customer AI wallet is charged in CNY:

- `0.500000 CNY` for every accepted tool-call attempt
- `0.500000 CNY` for every accepted trigger event

Tool calls require an idempotency key. A repeated key never calls Composio a
second time and never creates a second debit. Trigger events use Composio's
event ID as the idempotency key. A tool result error is still a consumed call;
the ledger records the failed outcome without refunding the fixed charge.

Execution is exposed through the authenticated workspace route
`POST /api/v1/workspaces/:workspaceId/composio/execute`. The session endpoint
does not expose an MCP transport, so customers cannot bypass the meter with a
direct session URL.

## Triggers

Set these server-side variables before creating customer triggers:

```text
COMPOSIO_API_KEY=...
COMPOSIO_WEBHOOK_SECRET=...
COMPOSIO_WEBHOOK_URL=https://lulu-ai.cn/api/v1/composio/webhook
```

`COMPOSIO_WEBHOOK_SECRET` must match the signing secret configured for the
Composio project webhook. Lulu verifies the raw webhook signature, resolves the
workspace-scoped Composio user identity, checks active membership and charges
the trigger before acknowledging the event. Missing funds return a stable
`COMPOSIO_FUNDS_REQUIRED`/`AI_REVERSAL_DEBT` error and the event is not
accepted.

Usage appears in the AI wallet overview and workspace billing response under
`composioUsage`.

Lulu platform admins with the `billing.bypass` capability are fully exempt
from Composio charges. Their tool calls and trigger events are executed without
debiting the workspace wallet. They are retained as zero-cost audit entries so
idempotency remains enforced, but excluded from customer usage totals. The
ordinary Workspace Admin role does not bypass billing.
