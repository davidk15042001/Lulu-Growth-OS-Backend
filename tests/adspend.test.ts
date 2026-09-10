import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateAdSpendCharge } from '../src/modules/adspend/adspend.service.js';

describe('autonomous advertising wallet', () => {
  it('charges the 4% Lulu fee on top without reducing the credited ad spend', () => {
    assert.deepEqual(calculateAdSpendCharge(10_000), {
      netAmount: 10_000,
      feeAmount: 400,
      totalAmount: 10_400,
      feeBasisPoints: 400,
      feePercent: 4,
      currency: 'CNY',
    });
  });

  it('accepts only the four explicit customer authorization packages', () => {
    for (const amount of [10_000, 25_000, 50_000, 90_000]) assert.equal(calculateAdSpendCharge(amount).netAmount, amount);
    assert.throws(() => calculateAdSpendCharge(123.45), { code: 'AD_SPEND_PACKAGE_INVALID' });
  });
});
