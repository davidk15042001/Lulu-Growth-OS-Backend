import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'crm-company-sync-tests-only-secret';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/crm_company_sync_tests_only';

const { buildCompanyProviderRequest, canonicalCompanyFields } = await import('../src/modules/provider-control/crm-company-sync.service.js');

describe('CRM company synchronization mapping', () => {
  const record = {
    name: 'Lulu Manufacturing',
    description: 'Canonical company description',
    data: {
      websiteUrl: 'https://lulu.example.com/about',
      email: 'hello@lulu.example.com',
      phone: '+86 10 1234 5678',
      industry: 'Manufacturing',
      country: 'China',
      city: 'Beijing',
      address: '1 Example Road',
    },
  } as const;

  it('keeps canonical company fields provider-neutral', () => {
    assert.deepEqual(canonicalCompanyFields(record), {
      name: 'Lulu Manufacturing',
      websiteUrl: 'https://lulu.example.com/about',
      email: 'hello@lulu.example.com',
      phone: '+86 10 1234 5678',
      industry: 'Manufacturing',
      country: 'China',
      city: 'Beijing',
      address: '1 Example Road',
      description: 'Canonical company description',
    });
  });

  it('builds idempotent update/create requests for each supported CRM', () => {
    const fields = canonicalCompanyFields(record);
    const salesforce = buildCompanyProviderRequest({ provider: 'salesforce', settings: { instanceUrl: 'https://example.salesforce.com' }, fields, externalObjectId: null });
    assert.equal(salesforce.method, 'POST');
    assert.match(salesforce.url, /sobjects\/Account$/);
    assert.equal((salesforce.body as Record<string, unknown>).Name, 'Lulu Manufacturing');

    const hubspot = buildCompanyProviderRequest({ provider: 'hubspot', settings: {}, fields, externalObjectId: '42' });
    assert.equal(hubspot.method, 'PATCH');
    assert.match(hubspot.url, /objects\/companies\/42$/);
    assert.equal(((hubspot.body.properties as Record<string, unknown>).domain), 'lulu.example.com');

    const pipedrive = buildCompanyProviderRequest({ provider: 'pipedrive', settings: { apiDomain: 'https://api.pipedrive.com' }, fields, externalObjectId: null });
    assert.equal(pipedrive.method, 'POST');
    assert.match(pipedrive.url, /api\/v1\/organizations$/);
    assert.equal((pipedrive.body as Record<string, unknown>).address_country, 'China');
  });
});
