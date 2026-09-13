import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

process.env.AIRWALLEX_WEBHOOK_SECRET ??= 'unit-test-webhook-secret';

const { verifyWebhookSignature } = await import('../src/modules/billing/airwallex.service.js');
const { AppError } = await import('../src/utils/app-error.js');

function signed(rawBody: string, timestamp = Date.now().toString()) {
  const signature = crypto.createHmac('sha256', process.env.AIRWALLEX_WEBHOOK_SECRET!)
    .update(`${timestamp}${rawBody}`)
    .digest('hex');
  return { timestamp, signature };
}

describe('Airwallex webhook signature verification', () => {
  it('accepts a valid signature', () => {
    const rawBody = '{"id":"evt_test"}';
    const headers = signed(rawBody);
    assert.doesNotThrow(() => verifyWebhookSignature(rawBody, headers.timestamp, headers.signature));
  });

  it('rejects missing signature headers with an exact code', () => {
    assert.throws(
      () => verifyWebhookSignature('{}', undefined, undefined),
      (error: unknown) => error instanceof AppError && error.code === 'AIRWALLEX_WEBHOOK_HEADERS_MISSING' && error.status === 403,
    );
  });

  it('rejects an invalid signature with an exact code', () => {
    const headers = signed('{}');
    assert.throws(
      () => verifyWebhookSignature('{}', headers.timestamp, `${headers.signature.slice(0, -1)}${headers.signature.endsWith('0') ? '1' : '0'}`),
      (error: unknown) => error instanceof AppError && error.code === 'AIRWALLEX_WEBHOOK_SIGNATURE_INVALID' && error.status === 403,
    );
  });

  it('rejects an invalid timestamp with an exact code', () => {
    const headers = signed('{}', 'not-a-number');
    assert.throws(
      () => verifyWebhookSignature('{}', headers.timestamp, headers.signature),
      (error: unknown) => error instanceof AppError && error.code === 'AIRWALLEX_WEBHOOK_TIMESTAMP_INVALID' && error.status === 403,
    );
  });

  it('rejects an expired timestamp with an exact code', () => {
    const timestamp = (Date.now() - 3_600_000).toString();
    const headers = signed('{}', timestamp);
    assert.throws(
      () => verifyWebhookSignature('{}', headers.timestamp, headers.signature),
      (error: unknown) => error instanceof AppError && error.code === 'AIRWALLEX_WEBHOOK_TIMESTAMP_EXPIRED' && error.status === 403,
    );
  });
});
