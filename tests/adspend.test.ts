import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateAdSpendCharge } from '../src/modules/adspend/adspend.service.js';

describe('autonomous advertising wallet', () => {
  it('charges the 4% Lulu fee on top without reducing the credited ad spend', () => {
    assert.deepEqual(calculateAdSpendCharge(100), {
      netAmount: 100,
      feeAmount: 4,
      totalAmount: 104,
      feeBasisPoints: 400,
      feePercent: 4,
      currency: 'CNY',
    });
  });

  it('rounds currency in minor units', () => {
    assert.deepEqual(calculateAdSpendCharge(123.45), {
      netAmount: 123.45,
      feeAmount: 4.94,
      totalAmount: 128.39,
      feeBasisPoints: 400,
      feePercent: 4,
      currency: 'CNY',
    });
  });
});
