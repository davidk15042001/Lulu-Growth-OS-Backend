import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  companyResearchFingerprint,
  companyResearchInputsChanged,
  normalizeCompanyData,
  queueCompanyResearch,
} from '../src/modules/crm-company/company-intelligence.model.js';

describe('CRM company intelligence model', () => {
  it('normalizes research seeds and queues autonomous enrichment', () => {
    const queued = queueCompanyResearch('Acme GmbH', {
      website: ' acme.example ',
      phoneNumber: ' +49 30 1234 ',
      socialProfiles: { LinkedIn: ' https://linkedin.com/company/acme ', empty: '' },
    });

    assert.equal(queued.websiteUrl, 'acme.example');
    assert.equal(queued.phone, '+49 30 1234');
    assert.deepEqual(queued.socialProfiles, { linkedin: 'https://linkedin.com/company/acme' });
    assert.equal(queued.enrichment.status, 'queued');
    assert.match(queued.enrichment.inputFingerprint, /^[a-f0-9]{64}$/);
  });

  it('does not requeue for derived AI metadata but detects customer corrections', () => {
    const before = normalizeCompanyData({ websiteUrl: 'https://acme.example', aiNotes: 'Old analysis' });
    const derived = { ...before, aiNotes: 'Updated analysis', enrichment: { status: 'complete' } };
    const corrected = { ...derived, city: 'Berlin' };

    assert.equal(companyResearchInputsChanged('Acme', before, 'Acme', derived), false);
    assert.equal(companyResearchInputsChanged('Acme', derived, 'Acme', corrected), true);
    assert.notEqual(companyResearchFingerprint('Acme', derived), companyResearchFingerprint('Acme', corrected));
  });
});
