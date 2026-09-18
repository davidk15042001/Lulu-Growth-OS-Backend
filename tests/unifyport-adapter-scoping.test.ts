import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/unifyport_adapter_tests_only';
process.env.JWT_SECRET = 'unifyport-adapter-tests-secret-0123456789';
process.env.UNIFYPORT_API_KEY = 'unifyport-adapter-test-key';
process.env.UNIFYPORT_BASE_URL = 'https://api.unifyport.ai';
process.env.UNIFYPORT_WEBHOOK_SIGNING_SECRET = 'unifyport-adapter-webhook-test-secret';

const { UnifyPortAdapter } = await import('../src/modules/provider-control/unifyport.adapter.js');

const context = (externalAccountId: string) => ({
  connectionId: 'provider-connection-test',
  providerKey: 'unifyport',
  workspaceId: 'workspace-test',
  externalAccountId,
  grantedScopes: [],
  metadata: {},
});

const accounts = [
  { id: 'acc-running', name: 'Running WhatsApp', provider: 'whatsapp', status: 'active', runtime_status: 'running' },
  { id: 'acc-pending', name: 'Pending WhatsApp', provider: 'whatsapp', status: 'active', runtime_status: 'pending' },
  { id: 'acc-email', name: 'Email account', provider: 'email', status: 'active', runtime_status: 'running' },
];

const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname;
  if (path === '/v1/workspace') return new Response(JSON.stringify({ data: { id: 'unifyport-workspace' } }), { status: 200 });
  if (path === '/v1/accounts') return new Response(JSON.stringify({ data: accounts }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
});

after(() => mock.restoreAll());

it('evaluates only the selected workspace account for UnifyPort readiness', async () => {
  const adapter = new UnifyPortAdapter();
  const ready = await adapter.verifyConnection(context('acc-running'));
  assert.equal(ready.verified, true);
  assert.equal(ready.status, 'CONNECTED');

  const pending = await adapter.verifyConnection(context('acc-pending'));
  assert.equal(pending.verified, false);
  assert.equal(pending.status, 'PROVIDER_REVIEW');
  assert.match(pending.reason, /active, running WhatsApp account/);

  const missing = await adapter.verifyConnection(context('acc-missing'));
  assert.equal(missing.verified, false);
  assert.equal(missing.status, 'PROVIDER_REVIEW');
  assert.match(missing.reason, /not available to this workspace/);
});

it('does not advertise messaging for a non-running or non-WhatsApp account', async () => {
  const adapter = new UnifyPortAdapter();
  const pendingCapabilities = await adapter.getCapabilities(context('acc-pending'));
  assert.equal(pendingCapabilities.find((item) => item.capabilityKey === 'unifyport.messages.send')?.status, 'UNCONFIRMED');
  assert.equal(pendingCapabilities.find((item) => item.capabilityKey === 'unifyport.messages.read')?.status, 'UNCONFIRMED');

  const emailCapabilities = await adapter.getCapabilities(context('acc-email'));
  assert.equal(emailCapabilities.find((item) => item.capabilityKey === 'unifyport.messages.send')?.status, 'UNCONFIRMED');

  const selected = await adapter.discoverAccounts(context('acc-running'));
  assert.deepEqual(selected.map((item) => item.externalAccountId), ['acc-running']);
  assert.ok(fetchMock.mock.calls.length > 0);
});
