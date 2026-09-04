import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiPreferencesSchema } from '../src/modules/onboarding/onboarding.validator.js';
import {
  createRecordSchema,
  listRecordsQuerySchema,
  recordParamsSchema,
} from '../src/modules/records/record.validator.js';
import { registerSchema } from '../src/modules/auth/auth.validator.js';
import {
  createSavedViewSchema,
  inviteMemberSchema,
  updateSavedViewSchema,
} from '../src/modules/workspace-app/workspace-app.validator.js';

describe('request validators', () => {
  it('normalizes registration email and enforces strong passwords', () => {
    const valid = registerSchema.parse({
      email: '  USER@Example.COM ',
      password: 'A-secure-password1',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    assert.equal(valid.email, 'user@example.com');
    assert.equal(registerSchema.safeParse({
      email: 'user@example.com',
      password: 'Short1!',
      first_name: 'Ada',
      last_name: 'Lovelace',
    }).success, false);
    for (const password of ['alllowercase1!', 'ALLUPPERCASE1!', 'NoNumber!', 'NoSpecial1']) {
      assert.equal(registerSchema.safeParse({
        email: 'user@example.com',
        password,
        first_name: 'Ada',
        last_name: 'Lovelace',
      }).success, false);
    }
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

  it('validates invitations and saved workspace views', () => {
    const invitation = inviteMemberSchema.parse({ email: ' ADMIN@Example.com ', role: 'admin' });
    const view = createSavedViewSchema.parse({
      resourceType: 'crm_contacts',
      name: 'Active enterprise contacts',
      filters: { status: 'active', tags: ['enterprise'] },
    });

    assert.equal(invitation.email, 'admin@example.com');
    assert.equal(view.isShared, false);
    assert.equal(view.isDefault, false);
    assert.equal(createSavedViewSchema.safeParse({ resourceType: 'not_real', name: 'Invalid' }).success, false);
    assert.equal(updateSavedViewSchema.safeParse({}).success, false);
  });
});
