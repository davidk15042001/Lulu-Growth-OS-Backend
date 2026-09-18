# UnifyPort WhatsApp production setup

Lulu only treats UnifyPort as a usable WhatsApp transport after the provider
workspace and account are reachable and the webhook can be authenticated.

## Required runtime configuration

Set these values in the production secret store or in the configured runtime
environment file. Never commit real values to Git:

```dotenv
UNIFYPORT_API_KEY=<provider-api-key>
UNIFYPORT_BASE_URL=https://api.unifyport.ai
UNIFYPORT_WEBHOOK_SIGNING_SECRET=<random-secret-at-least-32-characters>
```

`UNIFYPORT_WEBHOOK_SIGNING_SECRET` is mandatory whenever
`UNIFYPORT_API_KEY` is configured. Lulu rejects startup configuration that
would allow an unauthenticated UnifyPort webhook.

## Provider webhook

Configure the UnifyPort webhook to call:

```text
https://lulu-ai.cn/api/v1/provider-webhooks/unifyport
```

The endpoint verifies the configured signature, persists the provider event
idempotently, and lets the durable provider-webhook worker route inbound
messages and account lifecycle events. A repeated event must be accepted as a
duplicate without creating a second conversation message.

## Readiness sequence

1. Connect or authorize the WhatsApp account in UnifyPort.
2. Confirm that the account reports an active status and a running/ready
   runtime. An `active` account with a pending runtime is not considered
   connected.
3. Run the workspace provider readiness check in Lulu.
4. Confirm that `unifyport.messages.send` and `unifyport.messages.read` are
   `AVAILABLE`.
5. Perform one controlled outbound and inbound provider test. Only then
   advertise WhatsApp automation as production-ready for that workspace.

The readiness check is deliberately read-only. It never sends a WhatsApp
message or changes a provider account.

## Repeatable live read-only gate

For a release check, run the opt-in provider probe from the backend repository:

```bash
PROVIDER_LIVE_E2E=1 PROVIDER_LIVE_E2E_PROVIDERS=unifyport npm run provider:live-readiness
```

The command prints only provider status, capability status, and the number of
discovered accounts. It exits non-zero if verification, health, or any
advertised capability is not ready. The opt-in flag is mandatory so ordinary
development and CI test runs never call a live provider accidentally.

## Live transport acceptance test

`provider:live-readiness` is read-only. It verifies the configured workspace,
selected tenant account, health, capabilities and account discovery without
sending anything.

The separate `provider:live-e2e` command sends exactly one real WhatsApp text
message and is disabled unless all of these guards are supplied explicitly:

```text
PROVIDER_LIVE_E2E=1
PROVIDER_LIVE_E2E_SIDE_EFFECTS=1
PROVIDER_LIVE_E2E_CONFIRM=I_UNDERSTAND_THIS_SENDS_A_REAL_WHATSAPP_MESSAGE
PROVIDER_LIVE_E2E_WORKSPACE_ID=<workspace UUID>
PROVIDER_LIVE_E2E_EXTERNAL_ACCOUNT_ID=<running UnifyPort WhatsApp account>
PROVIDER_LIVE_E2E_RECIPIENT=<dedicated E.164 test number>
PROVIDER_LIVE_E2E_MESSAGE="[Lulu E2E] provider acceptance test"
```

Use only a dedicated test recipient. The command first verifies the selected
tenant account is active and running, then sends one text and requires a
provider message ID. It never retries an ambiguous send. Inbound webhook
acceptance can be included explicitly by adding
`PROVIDER_LIVE_E2E_VERIFY_INBOUND=1`,
`PROVIDER_LIVE_E2E_INBOUND_CONFIRM=I_UNDERSTAND_THIS_WAITS_FOR_A_REAL_INBOUND_REPLY`,
and `DATABASE_URL`. The command prints a unique
`[Lulu E2E INBOUND] ...` marker; send that exact marker from the dedicated
test recipient. It then requires both a tenant-scoped inbound message and a
`PROCESSED` signed webhook event for the selected account. The inbound wait is
disabled by default and has a bounded timeout, so normal deployment never
waits on provider traffic.
