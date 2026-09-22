-- Disable automatic PAYG collection. Usage billing remains enabled, but
-- customers pay storage invoices through explicit checkout/payment links.
UPDATE workspace_payg_profiles
SET collection_method='CHARGE_ON_CHECKOUT',
    provider_payment_source_id=NULL
WHERE collection_method='AUTO_CHARGE'
   OR provider_payment_source_id IS NOT NULL;

