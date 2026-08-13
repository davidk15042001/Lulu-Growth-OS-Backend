import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiPreferencesSchema } from '../src/modules/onboarding/onboarding.validator.js';
import {
  createRecordSchema,
  listRecordsQuerySchema,
  recordParamsSchema,
} from '../src/modules/records/record.validator.js';
import { registerSchema } from '../src/modules/auth/auth.validator.js';

describe('request validators', () => {
  it('normalizes registration email and enforces strong passwords', () => {
    const valid = registerSchema.parse({
      email: '  USER@Example.COM ',
      password: 'a-secure-password',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    assert.equal(valid.email, 'user@example.com');
    assert.equal(registerSchema.safeParse({
      email: 'user@example.com',
      password: 'too-short',
      first_name: 'Ada',
      last_name: 'Lovelace',
    }).success, false);
  });

  it('provides AI preference defaults matching onboarding', () => {
    const preferences = aiPreferencesSchema.parse({});
    assert.equal(preferences.recommendationStyle, 'balanced');
    assert.equal(preferences.riskTolerance, 'moderate');
    assert.equal(preferences.actionLevel, 'advisory');
    assert.equal(preferences.notificationChannels.in_app, true);
  });

  it('validates resource types and paginated filters', () => {
    const params = recordParamsSchema.parse({
      workspaceId: '0f7e4f08-a041-4aa5-bf32-b823295b7864',
      resourceType: 'crm_contacts',
    });
    const filters = listRecordsQuerySchema.parse({ page: '2', limit: '50' });
    assert.equal(params.resourceType, 'crm_contacts');
    assert.equal(filters.page, 2);
    assert.equal(filters.limit, 50);
    assert.equal(recordParamsSchema.safeParse({
      workspaceId: params.workspaceId,
      resourceType: 'unsupported',
    }).success, false);
  });

  it('normalizes currencies in record input', () => {
    const record = createRecordSchema.parse({
      name: 'Enterprise deal',
      currency: 'eur',
      valueAmount: '12000.50',
    });
    assert.equal(record.currency, 'EUR');
    assert.equal(record.valueAmount, 12000.5);
  });
});
