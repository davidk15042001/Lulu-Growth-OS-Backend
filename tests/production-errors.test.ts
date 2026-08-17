import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sendMail } from '../src/utils/mailer.js';
import { verifyWebhookSignature } from '../src/modules/billing/airwallex.service.js';
import { AppError } from '../src/utils/app-error.js';

describe('production error diagnostics', () => {
  it('reports missing Mailcow SMTP configuration with an exact code', async () => {
    await assert.rejects(
      () => sendMail('test@example.com', 'Test', '<p>Test</p>'),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'MAILCOW_SMTP_CONFIGURATION_MISSING');
        assert.equal(error.status, 503);
        assert.deepEqual(error.details, {
          missingEnv: ['MAILCOW_SMTP_HOST', 'MAILCOW_SMTP_USER', 'MAILCOW_SMTP_PASS', 'EMAIL_FROM'],
        });
        return true;
      },
    );
  });

  it('reports missing Airwallex webhook secret with an exact code', () => {
    if (process.env.AIRWALLEX_WEBHOOK_SECRET) return;
    assert.throws(
      () => verifyWebhookSignature('{}', '1700000000', 'signature', 'nonce'),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'AIRWALLEX_WEBHOOK_SECRET_MISSING');
        assert.equal(error.status, 500);
        return true;
      },
    );
  });
});
