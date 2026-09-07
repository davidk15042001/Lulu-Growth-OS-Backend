import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/provider_control_tests_only';
process.env.JWT_SECRET = 'provider-control-plane-tests-only-secret';
process.env.PROVIDER_WEBHOOK_SECRETS = JSON.stringify({ google_business: 'provider-webhook-test-secret' });

const { pool } = await import('../src/db/pool.js');
const providerService = await import('../src/modules/provider-control/provider.service.js');
const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
});

after(async () => { mock.restoreAll(); await pool.end(); await db.close(); });

async function fixture() {
  const owner = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  const outsider = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  const a = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Provider A',$1) RETURNING id`, [owner])).rows[0]!.id;
  const b = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Provider B',$1) RETURNING id`, [outsider])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')`, [a, owner, b, outsider]);
  const connection = (await db.query<{ id: string }>(`INSERT INTO provider_connections(scope_type,workspace_id,provider_key,mode,status,authorization_state,external_account_id,granted_scopes,metadata) VALUES('WORKSPACE',$1,'google_business','CUSTOMER_OWNED','CONNECTED','AUTHORIZED','gbp-1',ARRAY['business.manage'],'{}'::jsonb) RETURNING id`, [a])).rows[0]!.id;
  const account = (await db.query<{ id: string }>(`INSERT INTO provider_accounts(provider_connection_id,provider_key,external_account_id,name,metadata) VALUES($1,'google_business','gbp-1','Business A','{"accessToken":"secret","nested":{"refreshToken":"secret-2"}}'::jsonb) RETURNING id`, [connection])).rows[0]!.id;
  const asset = (await db.query<{ id: string }>(`INSERT INTO provider_assets(provider_account_id,provider_key,asset_type,external_asset_id,display_name) VALUES($1,'google_business','location','loc-1','Location A') RETURNING id`, [account])).rows[0]!.id;
  return { owner, outsider, a, b, connection, account, asset };
}

describe('Provider Control Plane', () => {
  it('keeps provider connections and assets workspace-scoped', async () => {
    const f = await fixture();
    const visible = await providerService.listWorkspaceProviders(f.a);
    assert.equal(visible.length, 1);
    assert.deepEqual(visible[0]?.accounts[0]?.metadata, { accessToken: '[REDACTED]', nested: { refreshToken: '[REDACTED]' } });
    await assert.rejects(providerService.getWorkspaceProvider(f.b, f.connection), { code: 'PROVIDER_CONNECTION_NOT_FOUND' });
    await assert.rejects(providerService.createWorkspaceProviderMapping({ workspaceId: f.b, actorId: f.outsider, providerConnectionId: f.connection, providerAccountId: f.account, providerAssetId: f.asset, luluObjectType: 'product', luluObjectId: crypto.randomUUID(), externalObjectType: 'location', externalObjectId: 'loc-2', sourceOfTruth: 'LULU_MASTER' }), { code: 'PROVIDER_TENANT_SCOPE_MISMATCH' });
  });

  it('resolves capability state conservatively and supports explicit modes', async () => {
    const f = await fixture();
    const verified = await providerService.verifyWorkspaceProvider(f.a, f.connection, f.owner);
    assert.equal(verified?.status, 'PROVIDER_REVIEW');
    assert.equal(verified?.healthStatus, 'PROVIDER_REVIEW');
    assert.ok(verified?.capabilities.every((capability) => capability.status === 'UNAVAILABLE' || capability.status === 'PROVIDER_REVIEW'));
    const changed = await providerService.changeWorkspaceProviderMode(f.a, f.connection, f.owner, 'HYBRID');
    assert.equal(changed.mode, 'HYBRID');
    const disconnected = await providerService.disconnectWorkspaceProvider(f.a, f.connection, f.owner);
    assert.equal(disconnected?.status, 'DISCONNECTED');
    assert.ok(disconnected?.capabilities.every((capability) => capability.status === 'UNAVAILABLE'));
  });

  it('rejects invalid webhook signatures and processes verified event IDs once', async () => {
    const f = await fixture();
    const rawBody = JSON.stringify({ id: 'evt-provider-1', type: 'account.updated' });
    const signature = crypto.createHmac('sha256', 'provider-webhook-test-secret').update(rawBody).digest('hex');
    await assert.rejects(providerService.ingestProviderWebhook({ provider: 'google_business', rawBody, payload: JSON.parse(rawBody), signature: `${signature.slice(0, -1)}0` }), { code: 'PROVIDER_WEBHOOK_SIGNATURE_INVALID' });
    const first = await providerService.ingestProviderWebhook({ provider: 'google_business', rawBody, payload: JSON.parse(rawBody), signature, connectionId: f.connection, correlationId: 'corr-1' });
    const second = await providerService.ingestProviderWebhook({ provider: 'google_business', rawBody, payload: JSON.parse(rawBody), signature, connectionId: f.connection, correlationId: 'corr-1' });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    const changedBody = JSON.stringify({ id: 'evt-provider-1', type: 'account.deleted' });
    const changedSignature = crypto.createHmac('sha256', 'provider-webhook-test-secret').update(changedBody).digest('hex');
    await assert.rejects(providerService.ingestProviderWebhook({ provider: 'google_business', rawBody: changedBody, payload: JSON.parse(changedBody), signature: changedSignature, connectionId: f.connection }), { code: 'PROVIDER_WEBHOOK_REPLAY_CONFLICT' });
    const events = await db.query<{ total: string }>(`SELECT count(*)::text AS total FROM provider_webhook_events WHERE provider_key='google_business' AND external_event_id='evt-provider-1'`);
    assert.equal(events.rows[0]?.total, '1');
  });

  it('requires an explicit access grant before exposing shared Lulu resources', async () => {
    const f = await fixture();
    const shared = (await db.query<{ id: string }>(`INSERT INTO provider_connections(scope_type,provider_key,mode,status,authorization_state,external_account_id,granted_scopes,metadata) VALUES('LULU_PLATFORM','google_business','LULU_MANAGED','CONNECTED','AUTHORIZED','gbp-shared',ARRAY['business.manage'],'{}'::jsonb) RETURNING id`)).rows[0]!.id;
    assert.equal((await providerService.listWorkspaceProviders(f.a)).length, 1);
    await assert.rejects(providerService.grantSharedProviderAccess({ providerConnectionId: shared, workspaceId: f.a, actorId: f.owner, grantedCapabilities: ['google_business.posts.publish'] }), { code: 'PROVIDER_CAPABILITY_UNKNOWN' });
    await providerService.grantSharedProviderAccess({ providerConnectionId: shared, workspaceId: f.a, actorId: f.owner, grantedCapabilities: ['google_business.reviews.read'] });
    const sharedView = (await providerService.listWorkspaceProviders(f.a)).find((connection) => connection.id === shared);
    assert.ok(sharedView);
    assert.ok(sharedView?.capabilities.find((capability) => capability.capabilityKey === 'google_business.locations.read')?.status === 'BLOCKED');
    assert.equal(sharedView?.capabilities.find((capability) => capability.capabilityKey === 'google_business.reviews.read')?.status, 'AVAILABLE');
    assert.equal((await providerService.listWorkspaceProviders(f.a)).length, 2);
    assert.equal((await providerService.listWorkspaceProviders(f.b)).length, 0);
    await providerService.revokeSharedProviderAccess({ providerConnectionId: shared, workspaceId: f.a, actorId: f.owner });
    assert.equal((await providerService.listWorkspaceProviders(f.a)).length, 1);
  });

  it('deduplicates concurrent sync requests and rejects invalid control subjects', async () => {
    const f = await fixture();
    const first = await providerService.queueWorkspaceProviderSync(f.a, f.connection, f.owner, 'full');
    const second = await providerService.queueWorkspaceProviderSync(f.a, f.connection, f.owner, 'full');
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(first.jobId, second.jobId);
    const jobs = await db.query<{ total: string }>(`SELECT count(*)::text AS total FROM background_jobs WHERE job_type='provider.sync' AND payload->>'providerConnectionId'=$1`, [f.connection]);
    assert.equal(jobs.rows[0]?.total, '1');
    await assert.rejects(
      db.query(`INSERT INTO provider_capability_states(provider_connection_id,subject_type,subject_id,capability_key,status,source) VALUES($1,'ACCOUNT',$2,'google_business.locations.read','AVAILABLE','MANUAL')`, [f.connection, crypto.randomUUID()]),
      /Provider control subject does not belong to the connection/,
    );
  });

  it('allows a shared connection to create an explicitly routed operation and mapping', async () => {
    const f = await fixture();
    const shared = (await db.query<{ id: string }>(`INSERT INTO provider_connections(scope_type,provider_key,mode,status,authorization_state,external_account_id,granted_scopes,metadata) VALUES('LULU_PLATFORM','google_business','LULU_MANAGED','CONNECTED','AUTHORIZED','gbp-shared-2',ARRAY['business.manage'],'{}'::jsonb) RETURNING id`)).rows[0]!.id;
    await providerService.grantSharedProviderAccess({ providerConnectionId: shared, workspaceId: f.a, actorId: f.owner, grantedCapabilities: ['google_business.locations.read'] });
    const account = (await db.query<{ id: string }>(`INSERT INTO provider_accounts(provider_connection_id,provider_key,external_account_id,name,metadata) VALUES($1,'google_business','gbp-shared-2','Shared','{}'::jsonb) RETURNING id`, [shared])).rows[0]!.id;
    const operation = await import('../src/modules/provider-control/provider.repo.js').then((repo) => repo.claimProviderOperation({ workspaceId: f.a, providerConnectionId: shared, operationKey: 'shared-op-1', operationType: 'READ' }));
    assert.equal(operation.created, true);
    const mapping = await providerService.createWorkspaceProviderMapping({ workspaceId: f.a, actorId: f.owner, providerConnectionId: shared, providerAccountId: account, luluObjectType: 'product', luluObjectId: crypto.randomUUID(), externalObjectType: 'location', externalObjectId: 'shared-location-1', sourceOfTruth: 'READ_ONLY' });
    assert.equal(mapping.workspaceId, f.a);
  });
});
