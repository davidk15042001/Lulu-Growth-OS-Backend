# Lulu customer metering

Status date: 2026-09-21

The 2026-09-21 pricing change doubles Lulu's customer-facing token and
Composio API meters. Kie media and Server PAYG retain their established 2x
provider-cost multiplier. No change mutates historical ledger rows, provider
cost records, prepaid wallet package balances, advertising principal, or
invoices that have already been issued.

## Customer rates

| Meter | Previous rate | Current rate | Source of truth |
| --- | ---: | ---: | --- |
| AI input tokens | USD 5 / 1M | USD 10 / 1M | `src/modules/usage/usage.service.ts` |
| AI output tokens | USD 10 / 1M | USD 20 / 1M | `src/modules/usage/usage.service.ts` |
| Composio tool-call attempt | CNY 0.50 | CNY 1.00 | `src/modules/composio/composio-usage.repo.ts` |
| Composio trigger event | CNY 0.50 | CNY 1.00 | `src/modules/composio/composio-usage.repo.ts` |
| Kie media credit | provider cost x2 | provider cost x2 | `KIE_CUSTOMER_MARKUP_MULTIPLIER` |
| Server PAYG allocation | provider cost x2 | provider cost x2 | `AWS_USAGE_CUSTOMER_MULTIPLIER` |

Kie and Server PAYG remain at the established provider-cost multiplier of two.
Historical Composio rows at CNY 0.50 remain valid for auditability; new rows
use CNY 1.00.

API top-up packages are wallet principal, not a per-call price. They remain
unchanged. R2 object storage is a separate storage meter rather than an
AI/API-call tariff and remains unchanged. Advertising budget is customer-owned
media spend and its separate service fee is not an AI/API meter, so it remains
unchanged as well.

## Provider research snapshot

Provider prices are volatile and remain separate from Lulu's customer rates.
The implementation currently records exact provider cost where the provider
returns usable evidence and otherwise keeps the ledger fail-closed.

- OpenAI model and token prices: <https://developers.openai.com/api/docs/models>
- Alibaba Cloud Model Studio / Qwen prices: <https://www.alibabacloud.com/help/en/model-studio/model-pricing>
- Groq model catalog and token prices: <https://console.groq.com/docs/models>
- Zep Cloud credit plans and metering: <https://www.getzep.com/pricing/>

Qwen's current international list prices include `qwen3.7-plus` at USD 0.40
input and USD 1.60 output per million tokens, which matches the provider-rate
test in this repository. OpenAI and Groq have model-specific rates, so the
customer tariff is intentionally a stable Lulu rate instead of copying a
provider's mutable catalog into customer invoices.
