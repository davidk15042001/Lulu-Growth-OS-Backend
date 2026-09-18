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
const providerRegistry = await import('../src/modules/provider-control/provider-registry.js');
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
  it('classifies provider contract evidence conservatively', () => {
    assert.equal(providerService.classifyProviderContract({ verification: { status: 'PASSED' }, capabilities: { status: 'PASSED' }, health: { status: 'PASSED' } }, [{ status: 'AVAILABLE' }]), 'PASSED');
    assert.equal(providerService.classifyProviderContract({ verification: { status: 'PASSED' }, capabilities: { status: 'PASSED' }, health: { status: 'FAILED', reason: 'timeout' } }, [{ status: 'AVAILABLE' }]), 'PARTIAL');
    assert.equal(providerService.classifyProviderContract({ verification: { status: 'FAILED', reason: 'reauth' }, capabilities: { status: 'SKIPPED' } }, []), 'FAILED');
    assert.equal(providerService.classifyProviderContract({ verification: { status: 'PASSED' } }, [{ status: 'UNCONFIRMED' }]), 'PARTIAL');
  });

  it('exposes a truthful production gate instead of treating connection state as readiness', () => {
    const connection = {
      id: crypto.randomUUID(), scopeType: 'WORKSPACE', providerKey: 'google_business', displayName: 'Google Business',
      status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', healthReason: null,
      capabilities: [{ status: 'AVAILABLE', capabilityKey: 'google_business.locations.read' }], syncStates: [],
    } as unknown as Parameters<typeof providerService.evaluateProviderLaunchReadiness>[0];
    const unverified = providerService.evaluateProviderLaunchReadiness(connection);
    assert.equal(unverified.status, 'UNVERIFIED');
    assert.equal(unverified.ready, false);
    assert.ok(unverified.blockers.some((blocker) => blocker.code === 'CONTRACT_CHECK_NOT_RUN'));

    const check = {
      id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), providerConnectionId: connection.id, providerKey: connection.providerKey,
      status: 'PASSED', phaseResults: {}, capabilities: [{ capabilityKey: 'google_business.locations.read', status: 'AVAILABLE' }],
      errorCode: null, errorMessage: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), createdBy: null, createdAt: new Date().toISOString(),
    } as Parameters<typeof providerService.evaluateProviderLaunchReadiness>[1];
    const ready = providerService.evaluateProviderLaunchReadiness(connection, check);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.ready, true);

    const pending = providerService.evaluateProviderLaunchReadiness(connection, { ...check, finishedAt: null } as unknown as Parameters<typeof providerService.evaluateProviderLaunchReadiness>[1]);
    assert.equal(pending.status, 'PENDING');
    assert.equal(pending.ready, false);
  });

  it('redacts credential-shaped sync errors from readiness evidence', () => {
    const connection = {
      id: crypto.randomUUID(), scopeType: 'WORKSPACE', providerKey: 'google_business', displayName: 'Google Business',
      status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', healthReason: null,
      capabilities: [{ status: 'AVAILABLE', capabilityKey: 'google_business.locations.read' }],
      syncStates: [{ syncType: 'reviews', status: 'FAILED', lastSuccessAt: null, lastAttemptAt: new Date().toISOString(), lastError: 'provider token=super-secret-value' }],
    } as unknown as Parameters<typeof providerService.evaluateProviderLaunchReadiness>[0];
    const check = {
      id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), providerConnectionId: connection.id, providerKey: connection.providerKey,
      status: 'PASSED', phaseResults: {}, capabilities: [{ capabilityKey: 'google_business.locations.read', status: 'AVAILABLE' }],
      errorCode: null, errorMessage: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), createdBy: null, createdAt: new Date().toISOString(),
    } as Parameters<typeof providerService.evaluateProviderLaunchReadiness>[1];
    const readiness = providerService.evaluateProviderLaunchReadiness(connection, check);
    assert.equal(readiness.evidence.sync[0]?.lastError, 'provider token: [redacted]');
    assert.equal(readiness.evidence.sync[0]?.lastError?.includes('super-secret-value'), false);
  });

  it('exposes runtime adapter readiness separately from the broad provider catalog', async () => {
    const catalog = await providerService.listProviderCatalog();
    const googleBusiness = catalog.find((entry) => entry.providerKey === 'google_business');
    const unifyPort = catalog.find((entry) => entry.providerKey === 'unifyport');
    assert.deepEqual(googleBusiness?.runtime, { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('does-not-exist'), { adapterRegistered: false, supportedFeatures: [] });
    assert.equal(unifyPort?.runtime?.adapterRegistered, true);
    assert.ok(unifyPort?.runtime?.supportedFeatures.includes('sync'));
    assert.ok(unifyPort?.runtime?.supportedFeatures.includes('webhook'));
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('airwallex'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('google_ads'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('wordpress'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('webflow'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('google_analytics'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('facebook'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('instagram'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('shopify'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('salesforce'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('hubspot'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('pipedrive'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('facebook_messenger'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('meta'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('linkedin'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
    assert.deepEqual(providerRegistry.getProviderRuntimeReadiness('tiktok_ads'), { adapterRegistered: true, supportedFeatures: ['verification', 'health', 'capabilities', 'discovery', 'sync'] });
  });

  it('keeps every catalog provider aligned with the executable adapter contract', () => {
    const methodByFeature: Record<string, string> = {
      verification: 'verifyConnection',
      health: 'getHealth',
      capabilities: 'getCapabilities',
      discovery: 'discoverAccounts',
      sync: 'sync',
      webhook: 'handleWebhook',
    };

    for (const entry of providerRegistry.PROVIDER_CATALOG) {
      const adapter = providerRegistry.getProviderAdapter(entry.providerKey);
      const runtime = providerRegistry.getProviderRuntimeReadiness(entry.providerKey);
      assert.equal(runtime.adapterRegistered, true, `${entry.providerKey} must have a fail-closed adapter`);
      assert.ok(runtime.supportedFeatures.includes('verification'), `${entry.providerKey} must expose verification`);
      for (const feature of runtime.supportedFeatures) {
        const method = methodByFeature[feature];
        assert.ok(method, `${entry.providerKey} exposes an unknown runtime feature: ${feature}`);
        assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], 'function', `${entry.providerKey} advertises ${feature} without ${method}()`);
      }
    }
  });

  it('describes WhatsApp as the UnifyPort-managed channel instead of a standalone Twilio provider', () => {
    const whatsapp = providerRegistry.PROVIDER_CATALOG.find((entry) => entry.providerKey === 'whatsapp');
    assert.equal(whatsapp?.displayName, 'WhatsApp via UnifyPort');
    assert.equal(whatsapp?.implementationStatus, 'PARTIAL');
    assert.equal(whatsapp?.defaultMode, 'LULU_MANAGED');
    assert.ok(whatsapp?.capabilities[0]?.displayName.includes('UnifyPort'));
  });

  it('does not treat an active but not-yet-running UnifyPort account as connected', async () => {
    assert.equal(providerRegistry.getProviderAdapter('unifyport').providerKey, 'unifyport');
    const { isUnifyPortAccountRuntimeReady } = await import('../src/modules/provider-control/unifyport.adapter.js');
    assert.equal(isUnifyPortAccountRuntimeReady({ status: 'active', runtime_status: 'pending' }), false);
    assert.equal(isUnifyPortAccountRuntimeReady({ status: 'active', runtime_status: 'running' }), true);
    assert.equal(isUnifyPortAccountRuntimeReady({ status: 'disabled', runtime_status: 'running' }), false);
  });

  it('verifies the Lulu-managed website from the canonical site and domain projection', async () => {
    const f = await fixture();
    const site = (await db.query<{ id: string }>(
      `INSERT INTO workspace_sites(workspace_id,provider,ownership_mode,name,external_site_id,status,settings)
       VALUES($1,'managed','managed','Lulu site','workspace-site-managed-1','published','{"managedWebsite":{"publicSlug":"site-a"}}'::jsonb)
       RETURNING id`,
      [f.a],
    )).rows[0]!.id;
    await db.query(
      `INSERT INTO workspace_site_domains(site_id,hostname,verification_token,status,verified_at)
       VALUES($1,'example.test','lulu-site=test-token','verified',NOW())`,
      [site],
    );
    const adapter = providerRegistry.getProviderAdapter('lulu_managed_website');
    const context = {
      connectionId: crypto.randomUUID(), providerKey: 'lulu_managed_website', workspaceId: f.a,
      externalAccountId: 'workspace-site-managed-1', grantedScopes: [], metadata: { legacySiteId: site },
    };
    const verified = await adapter.verifyConnection(context);
    assert.equal(verified.verified, true);
    assert.equal(verified.status, 'CONNECTED');
    assert.deepEqual((await adapter.getHealth!(context)).status, 'HEALTHY');
    assert.ok((await adapter.getCapabilities!(context)).every((capability) => capability.status === 'AVAILABLE'));
    const accounts = await adapter.discoverAccounts!(context);
    assert.equal(accounts.length, 1);
    const assets = await adapter.discoverAssets!(context, accounts[0]!);
    assert.deepEqual(assets.map((asset) => asset.assetType), ['managed_website', 'website_domain']);
    const sync = await adapter.sync!(context, 'full');
    assert.equal(sync.status, 'SUCCESS');
    await db.query(`UPDATE workspace_sites SET status='error' WHERE id=$1`, [site]);
    const failed = await adapter.verifyConnection(context);
    assert.equal(failed.verified, false);
    assert.equal(failed.status, 'ERROR');
  });

  it('keeps provider connections and assets workspace-scoped', async () => {
    const f = await fixture();
    const visible = await providerService.listWorkspaceProviders(f.a);
    assert.equal(visible.length, 1);
    assert.deepEqual(visible[0]?.accounts[0]?.metadata, { accessToken: '[REDACTED]', nested: { refreshToken: '[REDACTED]' } });
    const readiness = await providerService.getWorkspaceProviderLaunchReadiness(f.a);
    assert.equal(readiness.totalConnections, 1);
    assert.equal(readiness.connections[0]?.status, 'UNVERIFIED');
    assert.equal((await providerService.getWorkspaceProviderLaunchReadiness(f.b)).totalConnections, 0);
    await assert.rejects(providerService.getWorkspaceProvider(f.b, f.connection), { code: 'PROVIDER_CONNECTION_NOT_FOUND' });
    await assert.rejects(providerService.createWorkspaceProviderMapping({ workspaceId: f.b, actorId: f.outsider, providerConnectionId: f.connection, providerAccountId: f.account, providerAssetId: f.asset, luluObjectType: 'product', luluObjectId: crypto.randomUUID(), externalObjectType: 'location', externalObjectId: 'loc-2', sourceOfTruth: 'LULU_MASTER' }), { code: 'PROVIDER_TENANT_SCOPE_MISMATCH' });
  });

  it('resolves Google Business capability state from the real OAuth/API path and supports explicit modes', async () => {
    const f = await fixture();
    const verified = await providerService.verifyWorkspaceProvider(f.a, f.connection, f.owner);
    assert.equal(verified?.status, 'AUTHORIZATION_REQUIRED');
    assert.equal(verified?.healthStatus, 'AUTHORIZATION_REQUIRED');
    assert.ok(verified?.capabilities.every((capability) => capability.status === 'AUTHORIZATION_REQUIRED'));
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

  it('persists a provider-owned discovery snapshot idempotently', async () => {
    const f = await fixture();
    const repo = await import('../src/modules/provider-control/provider.repo.js');
    const account = { externalAccountId: 'gbp-1', name: 'Business A', accountType: 'LOCATION_GROUP', status: 'CONNECTED' as const, metadata: { locationCount: 1 } };
    const asset = { externalAssetId: 'loc-1', assetType: 'location', displayName: 'Location A', status: 'CONNECTED' as const, capabilities: { websiteUrl: 'https://example.test' }, metadata: { accountId: 'gbp-1' } };
    await repo.persistDiscoveredProviderGraph({ connectionId: f.connection, providerKey: 'google_business', accounts: [{ account, assets: [asset] }] });
    await repo.persistDiscoveredProviderGraph({ connectionId: f.connection, providerKey: 'google_business', accounts: [{ account, assets: [asset] }] });
    const counts = await db.query<{ accounts: string; assets: string }>(`SELECT (SELECT count(*)::text FROM provider_accounts WHERE provider_connection_id=$1) AS accounts, (SELECT count(*)::text FROM provider_assets WHERE provider_key='google_business' AND provider_account_id IN (SELECT id FROM provider_accounts WHERE provider_connection_id=$1)) AS assets`, [f.connection]);
    assert.deepEqual(counts.rows[0], { accounts: '1', assets: '1' });
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
