import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntegrationSyncError, IntegrationSyncFailure } from '../src/modules/workspace-app/integration-sync.worker.js';

test('integration sync failures preserve terminal prerequisite blocks', () => {
  const blocked = classifyIntegrationSyncError(new IntegrationSyncFailure(
    'INTEGRATION_SYNC_UNSUPPORTED',
    'No adapter is registered for this provider.',
    false,
  ));
  assert.equal(blocked.code, 'INTEGRATION_SYNC_UNSUPPORTED');
  assert.equal(blocked.retryable, false);
});

test('unknown integration sync failures remain retryable for bounded recovery', () => {
  const transient = classifyIntegrationSyncError(new Error('provider timed out'));
  assert.equal(transient.code, 'INTEGRATION_SYNC_UNEXPECTED');
  assert.equal(transient.retryable, true);
});
