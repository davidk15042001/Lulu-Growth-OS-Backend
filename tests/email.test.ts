import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRuleSchema,
  imapConnectSchema,
  listThreadsQuery,
  messageStateSchema,
} from '../src/modules/email/email.validator.js';
import { isPublicMailAddress } from '../src/modules/email/email.provider.service.js';

describe('email workspace validation', () => {
  it('accepts public mail hosts and standard mail ports', () => {
    const connection = imapConnectSchema.parse({
      emailAddress: 'Owner@Example.com',
      password: 'app-password',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
    });
    assert.equal(connection.emailAddress, 'Owner@Example.com');
    assert.equal(connection.imapHost, 'imap.example.com');
  });

  it('rejects local hosts and arbitrary ports to reduce SSRF risk', () => {
    const base = {
      emailAddress: 'owner@example.com', password: 'app-password', imapHost: 'imap.example.com',
      imapPort: 993, imapSecure: true, smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true,
    };
    assert.equal(imapConnectSchema.safeParse({ ...base, imapHost: 'localhost' }).success, false);
    assert.equal(imapConnectSchema.safeParse({ ...base, imapHost: '127.0.0.1' }).success, false);
    assert.equal(imapConnectSchema.safeParse({ ...base, smtpPort: 22 }).success, false);
    assert.equal(isPublicMailAddress('127.0.0.1'), false);
    assert.equal(isPublicMailAddress('169.254.169.254'), false);
    assert.equal(isPublicMailAddress('10.0.0.4'), false);
    assert.equal(isPublicMailAddress('::1'), false);
    assert.equal(isPublicMailAddress('fd00::1'), false);
    assert.equal(isPublicMailAddress('8.8.8.8'), true);
    assert.equal(isPublicMailAddress('2606:4700:4700::1111'), true);
  });

  it('permits draft-only AI automations and rejects an auto-send action', () => {
    const rule = createRuleSchema.parse({
      name: 'Prepare customer replies',
      conditions: { senderContains: '@customer.example', onlyUnread: true },
      actions: [{ type: 'generate_ai_draft', tone: 'professional', language: 'de' }],
    });
    assert.equal(rule.actions[0]?.type, 'generate_ai_draft');
    assert.equal(createRuleSchema.safeParse({
      name: 'Unsafe auto-send', conditions: {}, actions: [{ type: 'send_email' }],
    }).success, false);
  });

  it('bounds mailbox pagination and requires a real message state change', () => {
    assert.equal(listThreadsQuery.parse({ limit: '100' }).limit, 100);
    assert.equal(listThreadsQuery.parse({ starred: 'true' }).starred, true);
    assert.equal(listThreadsQuery.safeParse({ limit: '101' }).success, false);
    assert.equal(messageStateSchema.safeParse({}).success, false);
    assert.deepEqual(messageStateSchema.parse({ isRead: true }), { isRead: true });
  });
});
