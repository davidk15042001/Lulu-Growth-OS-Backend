import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateUsageCost } from '../src/modules/usage/usage.service.js';

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
