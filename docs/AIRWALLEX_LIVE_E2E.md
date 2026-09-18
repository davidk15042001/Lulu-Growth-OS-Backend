# Airwallex live payment acceptance

The normal deployment and readiness checks never create a payment. The
separate `airwallex:live-e2e` command is an operator-run acceptance test for
the complete customer-funded AI path:

```text
Airwallex payment
  -> provider-confirmed top-up
  -> wallet credit
  -> automatic Lulu invoice
  -> paid invoice PDF document
```

It is deliberately limited to exactly CNY 1.00 and requires three independent
guards. Run it only with a dedicated test workspace and a payment method that
can be completed by the operator:

```bash
AIRWALLEX_LIVE_E2E=1 \
AIRWALLEX_LIVE_E2E_SIDE_EFFECTS=1 \
AIRWALLEX_LIVE_E2E_CONFIRM=I_UNDERSTAND_THIS_CREATES_A_REAL_AIRWALLEX_PAYMENT \
AIRWALLEX_LIVE_E2E_WORKSPACE_ID=<dedicated-test-workspace> \
AIRWALLEX_LIVE_E2E_PAYMENT_METHOD=wechatpay \
npm run airwallex:live-e2e
```

Optional settings:

- `AIRWALLEX_LIVE_E2E_USER_ID` — explicit workspace owner/test user.
- `AIRWALLEX_LIVE_E2E_RETURN_URL` — valid post-payment return URL.
- `AIRWALLEX_LIVE_E2E_POLL_SECONDS` — polling interval, 1–60 seconds.
- `AIRWALLEX_LIVE_E2E_TIMEOUT_SECONDS` — payment window, 1–3600 seconds.

The command prints the hosted checkout URL or QR payload, waits for the
operator to complete payment, polls the provider, runs the same idempotent
invoice reconciliation used by production, and exits successfully only when
the wallet is credited and the Lulu invoice is `PAID` with a ready PDF
document. It never marks a top-up paid locally and never creates wallet funds
without the provider-confirmed result.
