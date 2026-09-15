import { reconcilePaidBillingInvoices } from '../dist/modules/billing/paid-billing-invoice.service.js';
import { pool } from '../dist/db/pool.js';

const batchSize = 200;
const maxPasses = 25;
let checked = 0;
let created = 0;
let failed = 0;

try {
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const result = await reconcilePaidBillingInvoices(batchSize);
    checked += result.checked;
    created += result.created;
    failed += result.failed ?? 0;
    console.log(JSON.stringify({ pass, ...result }));
    if (result.checked === 0 || result.created === 0) break;
  }

  console.log(JSON.stringify({
    checked,
    created,
    failed,
    message: failed > 0
      ? 'Some successful payments still need reconciliation; the background billing worker will retry them.'
      : 'Paid billing invoice reconciliation completed.',
  }));
} finally {
  await pool.end();
}
