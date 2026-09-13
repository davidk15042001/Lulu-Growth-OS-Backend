# Google Ads prepaid spend reconciliation

Google Ads campaign mutation and customer-wallet settlement are intentionally
separate operations.

## Invariants

- A customer campaign authorization and settled prepaid ad wallet are both
  required before launch.
- A launch accepts only a paused, single-campaign, non-shared `CUSTOM_PERIOD`
  budget in CNY.
- Lulu records the provider cost baseline before setting the provider lifetime
  ceiling to `baseline + customer cap`.
- A successful launch keeps the full cap `RESERVED`. A Google mutation response
  never proves that the cap was spent.
- Reconciliation converts only the increase in Google `metrics.cost_micros` to
  wallet `SPEND`, rounded down to the nearest CNY cent. Provider corrections are
  reflected back into the same reservation.
- Observation and settlement idempotency is scoped by workspace and backed by
  database uniqueness constraints.
- Network-ambiguous launch or pause outcomes retain the reservation.
- Pause, an externally stopped campaign, authorization expiry, payer changes,
  provider-cap changes, and observed over-cap cost all request safe closure.
- The unused remainder is released atomically only after the campaign is
  stopped, cost is stable for the configured safety period, and Google invoice
  coverage matches the immutable BillingSetup, Payments account, Payments
  profile, currency, and serving customer captured at launch.
- Missing or inconsistent final evidence never releases customer funds.

## Required production configuration

`GOOGLE_ADS_PREPAID_BILLING_ENABLED=true` is not sufficient on its own. The
following identifiers must match the live Google BillingSetup:

- `GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID`
- `GOOGLE_ADS_PREPAID_PAYMENTS_ACCOUNT_ID`
- `GOOGLE_ADS_PREPAID_PAYMENTS_PROFILE_ID`

The Google Ads developer token, OAuth client, and workspace OAuth credential
must also be valid. Readiness treats `google-ads-spend-reconciliation` as a
critical autonomous worker.

## Operational limit

Google invoice retrieval requires a monthly-invoicing BillingSetup. Accounts
without that provider evidence are deliberately launch-blocked or remain held;
Lulu does not infer final spend from a campaign mutation, UI state, or a local
timer. Live Google Ads sandbox/production validation and the real managed payer
contract remain release prerequisites outside automated repository tests.
