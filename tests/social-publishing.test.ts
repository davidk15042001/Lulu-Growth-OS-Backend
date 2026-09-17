import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/social_publishing_tests_only';
process.env.JWT_SECRET = 'social-publishing-tests-only-secret';
process.env.PROVIDER_CREDENTIAL_KEY = '31'.repeat(32);
process.env.PROVIDER_CREDENTIAL_KEY_VERSION = 'social-test';

const { pool } = await import('../src/db/pool.js');
const { encryptSecret } = await import('../src/utils/secret-box.js');
const service = await import('../src/modules/social-publishing/social-publishing.service.js');
const repo = await import('../src/modules/social-publishing/social-publishing.repo.js');
const records = await import('../src/modules/records/record.repo.js');
const officeRepo = await import('../src/modules/office/office.repo.js');
const { createMetaGraphClient, MetaGraphError } = await import('../src/modules/social-publishing/meta-graph.client.js');
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

async function fixture(provider: 'FACEBOOK' | 'INSTAGRAM' = 'FACEBOOK') {
  const owner = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  const outsider = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Social A',$1) RETURNING id`, [owner])).rows[0]!.id;
  const otherWorkspaceId = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Social B',$1) RETURNING id`, [outsider])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')`, [workspaceId, owner, otherWorkspaceId, outsider]);
  const providerKey = provider.toLowerCase();
  const scopes = provider === 'FACEBOOK'
    ? ['pages_manage_posts','pages_read_engagement']
    : ['instagram_basic','instagram_content_publish','pages_show_list','pages_read_engagement'];
  const platformId = (await db.query<{ id: string }>(
    `INSERT INTO workspace_platforms(workspace_id,integration_key,name,category,connection_status,external_account_id,granted_scopes)
     VALUES($1,$2,$3,'social','connected','meta-user-1',$4) RETURNING id`,
    [workspaceId, providerKey, provider === 'FACEBOOK' ? 'Facebook' : 'Instagram', scopes],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO workspace_platform_oauth_credentials(platform_id,provider,encrypted_access_token)
     VALUES($1,$2,$3)`,
    [platformId, providerKey, encryptSecret('user-token-secret')],
  );
  const connectionId = (await db.query<{ id: string }>(
    `INSERT INTO provider_connections(scope_type,workspace_id,provider_key,mode,status,authorization_state,
       credential_ref,source_type,source_id,external_account_id,granted_scopes,health_status)
     VALUES('WORKSPACE',$1,$2,'CUSTOMER_OWNED','CONNECTED','AUTHORIZED',$3,'workspace_platform',$4,'meta-user-1',$5,'HEALTHY') RETURNING id`,
    [workspaceId, providerKey, `workspace_platform_oauth_credentials:${platformId}`, platformId, scopes],
  )).rows[0]!.id;
  return { owner, outsider, workspaceId, otherWorkspaceId, connectionId, provider };
}

async function aiPublicationPacket(
  f: Awaited<ReturnType<typeof fixture>>,
  initialJobStatus: 'QUEUED' | 'FAILED' = 'QUEUED',
) {
  await db.query(`INSERT INTO resource_types(key,domain,label) VALUES
    ('marketing_content','marketing','Marketing content'),('activities','general','Activities')
    ON CONFLICT DO NOTHING`);
  const runId = (await db.query<{ id: string }>(
    `INSERT INTO agent_runs(workspace_id,created_by,goal,status,plan)
     VALUES($1,$2,'Publish social content','completed',$3::jsonb) RETURNING id`,
    [f.workspaceId, f.owner, JSON.stringify({ module: 'marketing', page: { pageId: 'wondrous-cloud-1355' } })],
  )).rows[0]!.id;
  const stepId = (await db.query<{ id: string }>(
    `INSERT INTO agent_run_steps(run_id,workspace_id,sequence_no,agent_role,title,instruction,status)
     VALUES($1,$2,1,'executor','Publish','Publish','completed') RETURNING id`,
    [runId, f.workspaceId],
  )).rows[0]!.id;
  const packet = await records.createRecord(f.workspaceId, 'marketing_content', f.owner, {
    name: 'AI social publication packet',
    source: 'page_agent',
    status: initialJobStatus === 'FAILED' ? 'failed' : 'active',
    stage: initialJobStatus === 'FAILED' ? 'execution_failed' : 'waiting_for_provider',
    data: {
      executionReady: false,
      executionStatus: initialJobStatus === 'FAILED' ? 'failed' : 'waiting_for_provider',
      executionRetryable: false,
      commands: [],
    },
  });
  await db.query(
    `INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [packet.id, f.workspaceId, runId, stepId, f.owner, crypto.randomUUID()],
  );
  const existingAccount = (await service.listAccounts(f.workspaceId)).find((candidate) => candidate.provider === 'FACEBOOK');
  const account = existingAccount ?? await (async () => {
    const createdAccount = await service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'AI Page', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: `ai-account-${crypto.randomUUID()}` });
    return (await service.verifyAccount({ workspaceId: f.workspaceId, accountId: createdAccount.account.id, actorId: f.owner, expectedVersion: createdAccount.account.version, graphClient: fakeMetaClient('FACEBOOK') }))!;
  })();
  const content = await service.createContent({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'AI_AGENT', actorRef: packet.id, contentType: 'TEXT', status: 'READY', message: 'AI provider publication', linkUrl: null, mediaUrl: null, altText: null, metadata: {}, idempotencyKey: `ai-content-${crypto.randomUUID()}` });
  const publication = await service.createPublication({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'AI_AGENT', actorRef: packet.id, socialAccountId: account.id, contentId: content.content.id, execution: 'QUEUE', scheduledAt: null, maxAttempts: 3, idempotencyKey: `ai-publication-${crypto.randomUUID()}` });
  if (initialJobStatus === 'FAILED') {
    await db.query(
      `UPDATE social_publication_jobs SET status='FAILED',finished_at=NOW(),last_error_code='TEST_FAILURE',
        last_error_message='Test failure',version=version+1 WHERE workspace_id=$1 AND id=$2`,
      [f.workspaceId, publication.job.id],
    );
  }
  const receipt = await records.createRecord(f.workspaceId, 'activities', f.owner, {
    parentId: packet.id,
    name: 'social.content.publish result',
    source: 'agent_executor_command',
    status: initialJobStatus === 'FAILED' ? 'failed' : 'active',
    stage: initialJobStatus === 'FAILED' ? 'provider_failed' : 'waiting_for_provider',
    externalId: crypto.randomUUID(),
    data: {
      sourceActionRecordId: packet.id,
      commandType: 'social.content.publish',
      commandProvider: 'facebook',
      commandResult: { publicationId: publication.job.id, status: initialJobStatus },
    },
  });
  const job = await service.getPublicationJob(f.workspaceId, publication.job.id);
  const officeItem = (await db.query<{ id: string }>(
    `SELECT id FROM office_work_items WHERE workspace_id=$1 AND source_record_id=$2`,
    [f.workspaceId, packet.id],
  )).rows[0]!;
  return { packet, receipt, job, officeItem };
}

function fakeMetaClient(provider: 'FACEBOOK' | 'INSTAGRAM', publish?: () => Promise<never>) {
  return {
    async verifyPage() {
      return { pageId: '12345', pageName: 'Verified Page', pageAccessToken: 'page-token', instagramBusinessAccountId: provider === 'INSTAGRAM' ? '98765' : null, instagramUsername: provider === 'INSTAGRAM' ? 'verified_shop' : null, providerRequestId: 'verify-trace' };
    },
    async verifyAdAccount() {
      return { adAccountId: 'act_12345', name: 'Test ad account', accountStatus: 1, currency: 'CNY', providerRequestId: 'ads-verify-trace' };
    },
    async listAdCampaigns() {
      return { campaigns: [], providerRequestId: 'ads-list-trace' };
    },
    async publishFacebook() {
      if (publish) return publish();
      return { providerPublicationId: '12345_555', providerRequestId: 'publish-trace' };
    },
    async publishInstagramImage() {
      if (publish) return publish();
      return { providerPublicationId: '178900001', providerRequestId: 'publish-trace', containerId: 'container-1' };
    },
  };
}

describe('Meta Graph publishing client', () => {
  it('uses bearer credentials and the real Facebook and Instagram publishing endpoints', async () => {
    const calls: Array<{ url: URL; method: string; authorization: string; body: string }> = [];
    const fetchImpl = (async (request: URL | RequestInfo, init?: RequestInit) => {
      const url = request instanceof URL ? request : new URL(String(request));
      calls.push({ url, method: String(init?.method ?? 'GET'), authorization: new Headers(init?.headers).get('authorization') ?? '', body: init?.body ? String(init.body) : '' });
      if (url.pathname.endsWith('/12345')) return Response.json({ id: '12345', name: 'Page', access_token: 'page-access', instagram_business_account: { id: '98765', username: 'shop' } }, { headers: { 'x-fb-trace-id': 'trace-verify' } });
      if (url.pathname.endsWith('/act_12345')) return Response.json({ id: 'act_12345', name: 'Ads', account_status: 1, currency: 'CNY' }, { headers: { 'x-fb-trace-id': 'trace-ads' } });
      if (url.pathname.endsWith('/act_12345/campaigns')) return Response.json({ data: [{ id: 'cmp-1', name: 'Launch', status: 'PAUSED', objective: 'OUTCOME_SALES' }] }, { headers: { 'x-fb-trace-id': 'trace-campaigns' } });
      if (url.pathname.endsWith('/12345/feed')) return Response.json({ id: '12345_444' }, { headers: { 'x-fb-trace-id': 'trace-feed' } });
      if (url.pathname.endsWith('/98765/media')) return Response.json({ id: 'container-1' });
      if (url.pathname.endsWith('/container-1')) return Response.json({ status_code: 'FINISHED' });
      if (url.pathname.endsWith('/98765/media_publish')) return Response.json({ id: 'ig-media-1' }, { headers: { 'x-fb-trace-id': 'trace-ig' } });
      return Response.json({ error: { code: 100, message: 'Unexpected request' } }, { status: 400 });
    }) as typeof fetch;
    const client = createMetaGraphClient({ fetchImpl, graphVersion: 'v23.0', sleepImpl: async () => undefined });
    const verified = await client.verifyPage({ accessToken: 'user-secret', facebookPageId: '12345', expectedInstagramBusinessAccountId: '98765' });
    const adAccount = await client.verifyAdAccount({ accessToken: 'user-secret', adAccountId: 'act_12345' });
    const campaigns = await client.listAdCampaigns({ accessToken: 'user-secret', adAccountId: adAccount.adAccountId });
    const facebook = await client.publishFacebook({ pageAccessToken: verified.pageAccessToken, facebookPageId: '12345', contentType: 'LINK', message: 'Launch', linkUrl: 'https://example.com/product' });
    const instagram = await client.publishInstagramImage({ pageAccessToken: verified.pageAccessToken, instagramBusinessAccountId: '98765', message: 'Premium', mediaUrl: 'https://cdn.example.com/image.jpg' });
    assert.equal(facebook.providerPublicationId, '12345_444');
    assert.equal(instagram.providerPublicationId, 'ig-media-1');
    assert.equal(adAccount.currency, 'CNY');
    assert.equal(campaigns.campaigns[0]?.id, 'cmp-1');
    assert.deepEqual(calls.map((call) => call.url.pathname), ['/v23.0/12345','/v23.0/act_12345','/v23.0/act_12345/campaigns','/v23.0/12345/feed','/v23.0/98765/media','/v23.0/container-1','/v23.0/98765/media_publish']);
    assert.ok(calls.every((call) => !call.url.toString().includes('user-secret') && !call.url.toString().includes('page-access')));
    assert.equal(calls[0]?.authorization, 'Bearer user-secret');
    assert.match(calls[3]?.body ?? '', /link=https%3A%2F%2Fexample.com%2Fproduct/);
  });

  it('treats an interrupted provider write as ambiguous instead of retrying into a duplicate post', async () => {
    const client = createMetaGraphClient({ fetchImpl: (async () => { throw new Error('socket closed'); }) as typeof fetch, graphVersion: 'v23.0' });
    await assert.rejects(
      client.publishFacebook({ pageAccessToken: 'secret', facebookPageId: '12345', contentType: 'TEXT', message: 'Only once' }),
      (error: unknown) => error instanceof MetaGraphError && error.code === 'META_PUBLISH_RESULT_UNKNOWN' && error.ambiguous && !error.retryable,
    );
  });
});

describe('Canonical social publishing', () => {
  it('keeps account, content and publication idempotency tenant-scoped', async () => {
    const f = await fixture();
    await assert.rejects(service.createAccount({ workspaceId: f.otherWorkspaceId, actorId: f.outsider, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'Foreign', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: 'foreign-account' }), { code: 'SOCIAL_PROVIDER_CONNECTION_NOT_FOUND' });
    const first = await service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'Page', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: 'account-once' });
    const replay = await service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'Page', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: 'account-once' });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(first.account.id, replay.account.id);
    await assert.rejects(service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'Different', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: 'account-once' }), { code: 'IDEMPOTENCY_KEY_REUSED' });
    assert.equal((await service.listAccounts(f.otherWorkspaceId)).length, 0);
  });

  it('publishes only after verified account and content state, recording real provider evidence', async () => {
    const f = await fixture();
    const createdAccount = await service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'Page', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: 'publish-account' });
    const account = await service.verifyAccount({ workspaceId: f.workspaceId, accountId: createdAccount.account.id, actorId: f.owner, expectedVersion: createdAccount.account.version, graphClient: fakeMetaClient('FACEBOOK') });
    assert.equal(account?.status, 'AVAILABLE');
    const content = await service.createContent({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, contentType: 'TEXT', status: 'READY', message: 'A real launch', linkUrl: null, mediaUrl: null, altText: null, metadata: {}, idempotencyKey: 'publish-content' });
    const publication = await service.createPublication({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, socialAccountId: account!.id, contentId: content.content.id, execution: 'QUEUE', scheduledAt: null, maxAttempts: 3, idempotencyKey: 'publish-job' });
    assert.equal(publication.job.status, 'QUEUED');
    const claimed = await repo.claimNextPublication('test-worker');
    assert.ok(claimed);
    await service.processClaimedPublication(claimed!, { graphClient: fakeMetaClient('FACEBOOK') });
    const finished = await service.getPublicationJob(f.workspaceId, publication.job.id);
    assert.equal(finished.status, 'PUBLISHED');
    assert.equal(finished.providerPublicationId, '12345_555');
    assert.equal(finished.attempts?.[0]?.status, 'SUCCEEDED');
    assert.equal(finished.attempts?.[0]?.requestSummary.provider, 'FACEBOOK');
    assert.equal(JSON.stringify(finished), JSON.stringify(finished).replaceAll('user-token-secret', '[secret]'));
  });

  it('retries explicit transient rejections and dead-letters exhausted attempts', async () => {
    const f = await fixture();
    const createdAccount = await service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'FACEBOOK', displayName: 'Page', facebookPageId: '12345', instagramBusinessAccountId: null, idempotencyKey: 'retry-account' });
    const account = await service.verifyAccount({ workspaceId: f.workspaceId, accountId: createdAccount.account.id, actorId: f.owner, expectedVersion: createdAccount.account.version, graphClient: fakeMetaClient('FACEBOOK') });
    const content = await service.createContent({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, contentType: 'TEXT', status: 'READY', message: 'Retry safely', linkUrl: null, mediaUrl: null, altText: null, metadata: {}, idempotencyKey: 'retry-content' });
    const publication = await service.createPublication({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, socialAccountId: account!.id, contentId: content.content.id, execution: 'QUEUE', scheduledAt: null, maxAttempts: 2, idempotencyKey: 'retry-job' });
    const transient = () => Promise.reject(new MetaGraphError('META_GRAPH_429', 'Rate limited', 'TRANSIENT', 429));
    const first = await repo.claimNextPublication('retry-worker');
    await service.processClaimedPublication(first!, { graphClient: fakeMetaClient('FACEBOOK', transient) });
    assert.equal((await service.getPublicationJob(f.workspaceId, publication.job.id)).status, 'QUEUED');
    await db.query(`UPDATE social_publication_jobs SET available_at=NOW() WHERE id=$1`, [publication.job.id]);
    const second = await repo.claimNextPublication('retry-worker');
    await service.processClaimedPublication(second!, { graphClient: fakeMetaClient('FACEBOOK', transient) });
    const exhausted = await service.getPublicationJob(f.workspaceId, publication.job.id);
    assert.equal(exhausted.status, 'FAILED');
    assert.deepEqual(exhausted.attempts?.map((attempt) => attempt.status), ['DEAD_LETTER','FAILED']);
  });

  it('blocks unsupported Instagram content and private media URLs before provider success is possible', async () => {
    const f = await fixture('INSTAGRAM');
    const createdAccount = await service.createAccount({ workspaceId: f.workspaceId, actorId: f.owner, providerConnectionId: f.connectionId, provider: 'INSTAGRAM', displayName: 'Instagram', facebookPageId: '12345', instagramBusinessAccountId: '98765', idempotencyKey: 'ig-account' });
    const account = await service.verifyAccount({ workspaceId: f.workspaceId, accountId: createdAccount.account.id, actorId: f.owner, expectedVersion: createdAccount.account.version, graphClient: fakeMetaClient('INSTAGRAM') });
    await assert.rejects(service.createContent({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, contentType: 'IMAGE', status: 'READY', message: 'Private', linkUrl: null, mediaUrl: 'https://127.0.0.1/private.jpg', altText: null, metadata: {}, idempotencyKey: 'private-media' }), (error: unknown) => error instanceof MetaGraphError && error.code === 'SOCIAL_MEDIA_URL_NOT_PUBLIC');
    const text = await service.createContent({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, contentType: 'TEXT', status: 'READY', message: 'Unsupported', linkUrl: null, mediaUrl: null, altText: null, metadata: {}, idempotencyKey: 'ig-text' });
    const blocked = await service.createPublication({ workspaceId: f.workspaceId, actorId: f.owner, actorType: 'USER', actorRef: f.owner, socialAccountId: account!.id, contentId: text.content.id, execution: 'QUEUE', scheduledAt: null, maxAttempts: 2, idempotencyKey: 'ig-blocked' });
    assert.equal(blocked.job.status, 'BLOCKED');
    assert.equal(blocked.job.blockCode, 'SOCIAL_MEDIA_UNSUPPORTED');
  });

  it('atomically cancels a linked canonical publication before cancelling its Office packet', async () => {
    const f = await fixture();
    const linked = await aiPublicationPacket(f);
    const officeItem = await officeRepo.findWorkItem(f.workspaceId, linked.officeItem.id);
    assert.ok(officeItem?.availableControls?.includes('cancel'));
    assert.ok(!officeItem?.availableControls?.includes('pause'));
    assert.ok(!officeItem?.availableControls?.includes('takeover'));
    await officeRepo.controlWorkItem({
      workspaceId: f.workspaceId,
      workItemId: linked.officeItem.id,
      action: 'cancel',
      actorId: f.owner,
      expectedVersion: officeItem!.version,
      idempotencyKey: `office-social-cancel-${crypto.randomUUID()}`,
    });
    const [job, packet, receipt] = await Promise.all([
      service.getPublicationJob(f.workspaceId, linked.job.id),
      records.findRecord(f.workspaceId, 'marketing_content', linked.packet.id),
      records.findRecord(f.workspaceId, 'activities', linked.receipt.id),
    ]);
    assert.equal(job.status, 'CANCELLED');
    assert.equal(job.executionActorType, 'AI_AGENT');
    assert.equal(job.executionActorRef, linked.packet.id);
    assert.equal(job.lastTransitionActorType, 'USER');
    assert.equal(job.lastTransitionActorId, f.owner);
    assert.equal(packet?.stage, 'execution_cancelled');
    assert.equal(receipt?.stage, 'execution_cancelled');
    assert.equal(await repo.claimNextPublication(`cancel-proof-${crypto.randomUUID()}`), null);
  });

  it('retries a failed linked publication through Office without re-running the action packet', async () => {
    const f = await fixture();
    const linked = await aiPublicationPacket(f, 'FAILED');
    const officeItem = await officeRepo.findWorkItem(f.workspaceId, linked.officeItem.id);
    assert.ok(officeItem?.availableControls?.includes('retry'));
    const controlled = await officeRepo.controlWorkItem({
      workspaceId: f.workspaceId,
      workItemId: linked.officeItem.id,
      action: 'retry',
      actorId: f.owner,
      expectedVersion: officeItem!.version,
      idempotencyKey: `office-social-retry-${crypto.randomUUID()}`,
    });
    const [job, packet, receipt] = await Promise.all([
      service.getPublicationJob(f.workspaceId, linked.job.id),
      records.findRecord(f.workspaceId, 'marketing_content', linked.packet.id),
      records.findRecord(f.workspaceId, 'activities', linked.receipt.id),
    ]);
    assert.equal(job.status, 'QUEUED');
    assert.equal(controlled.item.status, 'waiting');
    assert.equal(packet?.status, 'active');
    assert.equal(packet?.stage, 'waiting_for_provider');
    assert.equal(packet?.data?.executionReady, false);
    assert.equal(receipt?.stage, 'waiting_for_provider');
  });

  it('preserves AI provenance and reconciles manual social cancel and retry transitions', async () => {
    const f = await fixture();
    const cancelled = await aiPublicationPacket(f);
    const cancelledJob = await service.transitionPublication({
      workspaceId: f.workspaceId,
      jobId: cancelled.job.id,
      actorId: f.owner,
      actorType: 'USER',
      actorRef: f.owner,
      expectedVersion: cancelled.job.version,
      action: 'CANCEL',
    });
    assert.equal(cancelledJob.executionActorType, 'AI_AGENT');
    assert.equal(cancelledJob.executionActorRef, cancelled.packet.id);
    assert.equal(cancelledJob.lastTransitionActorType, 'USER');
    assert.equal((await records.findRecord(f.workspaceId, 'marketing_content', cancelled.packet.id))?.stage, 'execution_cancelled');
    assert.equal((await records.findRecord(f.workspaceId, 'activities', cancelled.receipt.id))?.stage, 'execution_cancelled');

    const retrying = await aiPublicationPacket(f, 'FAILED');
    const retriedJob = await service.transitionPublication({
      workspaceId: f.workspaceId,
      jobId: retrying.job.id,
      actorId: f.owner,
      actorType: 'USER',
      actorRef: f.owner,
      expectedVersion: retrying.job.version,
      action: 'RETRY',
    });
    assert.equal(retriedJob.status, 'QUEUED');
    assert.equal(retriedJob.executionActorType, 'AI_AGENT');
    assert.equal(retriedJob.executionActorRef, retrying.packet.id);
    assert.equal(retriedJob.lastTransitionActorType, 'USER');
    assert.equal((await records.findRecord(f.workspaceId, 'marketing_content', retrying.packet.id))?.stage, 'waiting_for_provider');
    assert.equal((await records.findRecord(f.workspaceId, 'activities', retrying.receipt.id))?.stage, 'waiting_for_provider');
  });
});
