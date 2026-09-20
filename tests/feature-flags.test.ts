import assert from 'node:assert/strict';
import test from 'node:test';
import { enabledForRollout, rolloutBucket } from '../src/operations/feature-flags.js';

test('feature flag rollout buckets are deterministic and bounded', () => {
  const first = rolloutBucket('00000000-0000-4000-8000-000000000001', 'deep.research');
  const second = rolloutBucket('00000000-0000-4000-8000-000000000001', 'deep.research');
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 100);
  assert.equal(enabledForRollout('workspace', 'deep.research', true, 0), true);
  assert.equal(enabledForRollout('workspace', 'deep.research', false, 0), false);
});
