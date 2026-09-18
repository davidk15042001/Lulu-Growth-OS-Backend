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
