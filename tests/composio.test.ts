import assert from 'node:assert/strict';
import test from 'node:test';
import { getComposioUserId, normalizeComposioToolkit } from '../src/modules/composio/composio.service.js';

test('Composio identities remain stable and workspace-scoped', () => {
  assert.equal(getComposioUserId('workspace-a', 'user-1'), 'lulu:workspace-a:user-1');
  assert.notEqual(getComposioUserId('workspace-a', 'user-1'), getComposioUserId('workspace-b', 'user-1'));
});

test('Composio toolkit slugs are normalized and invalid values fail closed', () => {
  assert.equal(normalizeComposioToolkit('  Gmail  '), 'gmail');
  assert.throws(() => normalizeComposioToolkit('gmail/connect'), { code: 'COMPOSIO_TOOLKIT_INVALID' });
  assert.throws(() => normalizeComposioToolkit(''), { code: 'COMPOSIO_TOOLKIT_INVALID' });
});
