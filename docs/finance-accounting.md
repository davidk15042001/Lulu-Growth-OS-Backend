# Operational finance and accounting

Lulu's finance module is an immutable operational subledger. It gives the
Workspace, Virtual Office and autonomous workflows one canonical view of
invoice receivables and recorded receipts. It is not a statutory general
ledger, a tax engine, or tax advice.

## Posting model

Every journal is written atomically and must balance in integer ISO currency
minor units. A workspace-scoped idempotency key and payload hash make retries
safe while rejecting reuse of a key for a different posting. Journal headers,
lines, and invoice payments are append-only.

- Issued non-proforma invoice: debit `ACCOUNTS_RECEIVABLE`; credit
  `SALES_REVENUE`; where the canonical invoice contains an explicit tax total,
  that amount is credited to `TAX_PAYABLE` and the remainder to revenue.
- Recorded invoice payment: debit `PAYMENT_CLEARING`; credit
  `ACCOUNTS_RECEIVABLE`. `PAYMENT_CLEARING` means a receipt was recorded, not
  that a bank statement has been reconciled.
- Proforma invoices do not create a receivable.
- Source values with more precision than a currency minor unit use explicit
  half-up rounding; the journal metadata records that policy.

## APIs

Mount `finance.routes.ts` at `/api/v1/workspaces/:workspaceId/finance`.

- `GET /journals`
- `GET /journals/:journalId`
- `GET /accounts/:accountCode/balance?currency=CNY`
- `GET /trial-balance?currency=CNY`

Invoice receipts use the existing commercial-document service and therefore
the same canonical object for users and AI actors:

- `GET /commercial-documents/invoices/:invoiceId/payments`
- `POST /commercial-documents/invoices/:invoiceId/payments`

The POST body requires a caller-owned `idempotencyKey`, decimal `amount`,
`paymentMethod`, and optionally `paymentReference`, `receivedAt`, and metadata.
It rejects overpayments and transitions the invoice to `PARTIALLY_PAID` or
`PAID` in the same database transaction as the immutable receipt and event.
