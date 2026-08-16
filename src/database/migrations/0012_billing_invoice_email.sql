ALTER TABLE workspace_billing_checkouts
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url text,
  ADD COLUMN IF NOT EXISTS invoice_email_sent_at timestamptz;
