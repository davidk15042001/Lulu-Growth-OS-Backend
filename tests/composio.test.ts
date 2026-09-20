import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getComposioUserId,
  normalizeComposioIdempotencyKey,
  normalizeComposioToolSlug,
  normalizeComposioToolkit,
  parseComposioUserId,
} from '../src/modules/composio/composio.service.js';
import { COMPOSIO_TOOL_CALL_PRICE_CNY, COMPOSIO_TRIGGER_PRICE_CNY } from '../src/modules/composio/composio-usage.repo.js';

test('Composio identities remain stable and workspace-scoped', () => {
  assert.equal(getComposioUserId('workspace-a', 'user-1'), 'lulu:workspace-a:user-1');
  assert.notEqual(getComposioUserId('workspace-a', 'user-1'), getComposioUserId('workspace-b', 'user-1'));
});

test('Composio toolkit slugs are normalized and invalid values fail closed', () => {
  assert.equal(normalizeComposioToolkit('  Gmail  '), 'gmail');
  assert.throws(() => normalizeComposioToolkit('gmail/connect'), { code: 'COMPOSIO_TOOLKIT_INVALID' });
  assert.throws(() => normalizeComposioToolkit(''), { code: 'COMPOSIO_TOOLKIT_INVALID' });
});

test('Composio billing uses the fixed CNY price for both meter types', () => {
  assert.equal(COMPOSIO_TOOL_CALL_PRICE_CNY, '0.500000');
  assert.equal(COMPOSIO_TRIGGER_PRICE_CNY, '0.500000');
});

test('Composio execution identities and keys are validated', () => {
  assert.equal(normalizeComposioToolSlug('GITHUB_GET_ISSUES'), 'GITHUB_GET_ISSUES');
  assert.equal(normalizeComposioIdempotencyKey(' request-1 '), 'request-1');
  assert.deepEqual(parseComposioUserId('lulu:workspace-1:user-1'), {
    workspaceId: 'workspace-1',
    userId: 'user-1',
  });
  assert.throws(() => normalizeComposioToolSlug('github/get'), { code: 'COMPOSIO_TOOL_INVALID' });
  assert.throws(() => parseComposioUserId('external-user'), { code: 'COMPOSIO_USER_INVALID' });
});
