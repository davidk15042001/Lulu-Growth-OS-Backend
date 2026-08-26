import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateUsageCost } from '../src/modules/usage/usage.service.js';
import { deterministicBillingRequestId } from '../src/modules/billing/airwallex.service.js';

describe('AI usage pricing', () => {
  it('prices qwen3.7-plus usage with the Singapore international list rate', () => {
    const usage = calculateUsageCost({
      provider: 'alibaba',
      model: 'qwen3.7-plus',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    assert.deepEqual(usage.rate, { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6 });
    assert.equal(usage.providerCostUsd, 2);
    assert.equal(usage.customerCostUsd, 6);
    assert.equal(usage.credits, 2_000);
  });

  it('prices deepseek-v4-pro usage with the Singapore international list rate', () => {
    const usage = calculateUsageCost({
      provider: 'alibaba',
      model: 'deepseek-v4-pro',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    assert.deepEqual(usage.rate, { inputPerMillionUsd: 1.65, outputPerMillionUsd: 3.301 });
    assert.ok(Math.abs(usage.providerCostUsd - 4.951) < 1e-9);
    assert.ok(Math.abs(usage.customerCostUsd - 14.853) < 1e-9);
  });
});

describe('PAYG billing idempotency', () => {
  it('creates stable, distinct UUID request IDs for every invoice stage', () => {
    const periodId = 'f65d8bc0-462d-41b6-bf17-60f237cb41d8';
    const invoice = deterministicBillingRequestId(`payg-invoice:${periodId}`);
    const lineItems = deterministicBillingRequestId(`payg-line-items:${periodId}`);

    assert.match(invoice, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(invoice, deterministicBillingRequestId(`payg-invoice:${periodId}`));
    assert.notEqual(invoice, lineItems);
  });
});
