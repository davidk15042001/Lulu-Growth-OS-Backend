import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'oauth-config-tests-secret-0123456789';
delete process.env.META_CLIENT_ID;
delete process.env.META_CLIENT_SECRET;

const oauthService = await import('../src/modules/onboarding/oauth.service.js');

describe('Onboarding OAuth configuration', () => {
  it('reports missing Meta admin OAuth credentials as unavailable server configuration', () => {
    assert.throws(
      () => oauthService.buildAdminAuthorizationUrl('meta', 'admin-user-id', '/app/admin-billing-overview-9901?page=oauth-connections'),
      {
        name: 'AppError',
        status: 503,
        code: 'OAUTH_PROVIDER_CREDENTIALS_MISSING',
        details: {
          provider: 'meta',
          requiredEnv: ['META_CLIENT_ID', 'META_CLIENT_SECRET'],
        },
      },
    );
  });
});
