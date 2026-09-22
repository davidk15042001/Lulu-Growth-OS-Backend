import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryCodes, totpCode, totpSecretUri, verifyTotp } from '../src/utils/totp.js';

test('TOTP codes verify in the configured clock window and reject invalid values', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const timestamp = 1_700_000_000_000;
  const code = totpCode(secret, timestamp);

  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, timestamp), true);
  assert.equal(verifyTotp(secret, code, timestamp + 30_000), true);
  assert.equal(verifyTotp(secret, '000000', timestamp), false);
});

test('TOTP setup metadata is compatible with authenticator apps', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const uri = totpSecretUri(secret, 'owner@example.com');
  assert.match(uri, /^otpauth:\/\/totp\/Lulu%3Aowner%40example\.com\?/);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /issuer=Lulu%20Growth%20OS/);
});

test('recovery codes are unique, formatted, and bounded', () => {
  const codes = createRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((code) => /^[A-Z0-9]{8}-[A-Z0-9]{8}$/.test(code)));
});
