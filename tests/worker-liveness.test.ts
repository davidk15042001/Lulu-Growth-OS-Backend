import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, it, mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/worker_liveness_tests_only';
process.env.JWT_SECRET = 'worker-liveness-tests-only-secret';

const { pool } = await import('../src/db/pool.js');
const liveness = await import('../src/operations/worker-liveness.js');
const { autonomousWorkerManifest } = await import('../src/operations/autonomous-worker-manifest.js');
const db = new PGlite();
type QueryGate = { pattern: string; entered: () => void; wait: Promise<void> };
let queryGate: QueryGate | null = null;

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    const gate = queryGate;
    if (gate && sql.includes(gate.pattern)) {
      queryGate = null;
      gate.entered();
      await gate.wait;
    }
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
});

after(async () => {
  await liveness.stopWorkerSupervisorHeartbeat();
  mock.restoreAll();
  await pool.end();
  await db.close();
});

describe('per-worker runtime readiness', () => {
  it('treats every customer-facing autonomous execution loop as readiness-critical', () => {
    const required = new Set<string>(autonomousWorkerManifest.filter((worker) => worker.required).map((worker) => worker.name));
    for (const worker of [
      'agent-execution', 'agent-runs', 'domain-events', 'automatic-analysis',
      'assistant-actions', 'content-generation', 'email-sync', 'calendar-sync',
      'website-generation', 'payg-billing', 'admin-user-deletion', 'provider-control',
      'commercial-document-delivery', 'premium-media', 'omnichannel-ai-reply',
      'social-publishing', 'company-intelligence',
      'google-ads-spend-reconciliation', 'quality-intelligence',
    ]) {
      assert.equal(required.has(worker), true, `${worker} must block readiness when unhealthy`);
    }
    assert.equal(required.has('rate-limit-cleanup'), false);
    assert.equal(required.has('onboarding-cleanup'), false);
  });

  it('never turns a missing or failed critical worker green from the supervisor heartbeat alone', async () => {
    await liveness.startWorkerSupervisorHeartbeat([
      { name: 'critical-test-worker', required: true, staleAfterMs: 60_000 },
      { name: 'optional-test-worker', required: false, staleAfterMs: 60_000 },
    ]);

    const missing = await liveness.getWorkerSupervisorHealth();
    assert.equal(missing.supervisorLive, true);
    assert.equal(missing.live, false);
    assert.deepEqual(missing.unhealthyRequiredWorkers, ['critical-test-worker']);

    await liveness.markRuntimeWorkerStarted('critical-test-worker', { required: true, staleAfterMs: 60_000 });
    await liveness.markRuntimeWorkerProgress('critical-test-worker', { phase: 'idle', processed: 0 });
    const healthy = await liveness.getWorkerSupervisorHealth();
    assert.equal(healthy.live, true);
    assert.equal(healthy.workers.find((worker) => worker.name === 'critical-test-worker')?.ready, true);
    assert.equal(healthy.workers.find((worker) => worker.name === 'optional-test-worker')?.ready, false);

    await liveness.markRuntimeWorkerFailed('critical-test-worker', new Error('poll loop failed'));
    const failed = await liveness.getWorkerSupervisorHealth();
    assert.equal(failed.live, false);
    assert.equal(failed.workers.find((worker) => worker.name === 'critical-test-worker')?.lastError, 'poll loop failed');

    await liveness.markRuntimeWorkerProgress('critical-test-worker', { phase: 'recovered' });
    assert.equal((await liveness.getWorkerSupervisorHealth()).live, true);

    await liveness.markRuntimeWorkerStopped('critical-test-worker');
    const stopped = await liveness.getWorkerSupervisorHealth();
    assert.equal(stopped.live, false);
    assert.equal(stopped.workers.find((worker) => worker.name === 'critical-test-worker')?.status, 'STOPPED');
  });

  it('drains active agent execution and agent-run polls before stop resolves', async () => {
    const executionWorker = await import('../src/modules/agents/agent-execution.worker.js');
    const runWorker = await import('../src/modules/agents/agent-run.worker.js');

    const verifyDrain = async (workerName: string, pattern: string, runCycle: () => Promise<void>, stop: () => Promise<void>) => {
      await liveness.stopWorkerSupervisorHeartbeat();
      await liveness.startWorkerSupervisorHeartbeat([{ name: workerName, required: true, staleAfterMs: 60_000 }]);
      await liveness.markRuntimeWorkerStarted(workerName, { required: true, staleAfterMs: 60_000 });
      await liveness.markRuntimeWorkerProgress(workerName, { phase: 'processing' });
      let releaseQuery!: () => void;
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const wait = new Promise<void>((resolve) => { releaseQuery = resolve; });
      queryGate = { pattern, entered: signalEntered, wait };
      void runCycle();
      await entered;

      let stopped = false;
      const stopping = stop().then(() => { stopped = true; });
      let stoppingObserved = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const health = await liveness.getWorkerSupervisorHealth();
        if (health.workers[0]?.phase === 'stopping') {
          stoppingObserved = true;
          assert.equal(health.live, false, 'readiness stayed green while the worker was draining');
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(stoppingObserved, true, 'worker did not publish a stopping readiness state');
      assert.equal(stopped, false, 'stop resolved while a database cycle was still active');
      releaseQuery();
      await stopping;
      assert.equal(stopped, true);
      assert.equal((await liveness.getWorkerSupervisorHealth()).workers[0]?.status, 'STOPPED');
    };

    await verifyDrain(
      'agent-execution',
      "source = 'page_agent'",
      executionWorker.runAgentExecutionCycle,
      executionWorker.stopAgentExecutionWorker,
    );
    await verifyDrain(
      'agent-runs',
      "SET status='failed', error_code='AGENT_RUN_AUTO_PAUSED'",
      runWorker.runAgentRunWorkerCycle,
      runWorker.stopAgentRunWorker,
    );
  });

  it('drains representative side-effect workers before reporting STOPPED', async () => {
    const assistant = await import('../src/modules/ai/assistant-action.worker.js');
    const content = await import('../src/modules/content-generation/content-generation.worker.js');
    const email = await import('../src/modules/email/email.service.js');
    const calendar = await import('../src/modules/calendar/calendar.worker.js');
    const website = await import('../src/modules/websites/website.worker.js');
    const onboarding = await import('../src/modules/onboarding/onboarding-cleanup.worker.js');
    const billing = await import('../src/modules/billing/payg-billing.worker.js');
    const deletion = await import('../src/modules/admin/admin-user-deletion.worker.js');
    const delivery = await import('../src/modules/commercial-documents/commercial-document.delivery.service.js');
    const media = await import('../src/modules/premium-media/premium-media.worker.js');
    const company = await import('../src/modules/crm-company/company-intelligence.worker.js');
    const omnichannel = await import('../src/modules/omnichannel/omnichannel.ai-reply.worker.js');
    const googleAds = await import('../src/modules/adspend/google-ads-spend.worker.js');
    const rateLimits = await import('../src/middlewares/rateLimit.middleware.js');

    const cases: Array<[string, string, () => Promise<void>, () => Promise<void>]> = [
      ['assistant-actions', "SET status='failed',error_code='ASSISTANT_ACTION_STATE_UNCERTAIN'", assistant.runAssistantActionCycle, assistant.stopAssistantActionWorker],
      ['content-generation', 'UPDATE workspace_content_refresh_jobs', content.runContentGenerationCycle, content.stopContentGenerationWorker],
      ['email-sync', 'FROM email_accounts', email.runEmailSyncCycle, email.stopEmailSyncWorker],
      ['calendar-sync', 'FROM calendar_accounts', calendar.runCalendarSyncCycle, calendar.stopCalendarSyncWorker],
      ['website-generation', 'WITH exhausted AS', website.runWebsiteGenerationCycle, website.stopWebsiteGenerationWorker],
      ['onboarding-cleanup', 'WITH candidate AS', onboarding.runOnboardingFileCleanupCycle, onboarding.stopOnboardingFileCleanupWorker],
      ['payg-billing', 'UPDATE workspace_payg_profiles p', billing.runPaygBillingCycle, billing.stopPaygBillingWorker],
      ['admin-user-deletion', 'FROM background_jobs', deletion.runAdminUserDeletionWorkerCycle, deletion.stopAdminUserDeletionWorker],
      ['commercial-document-delivery', "UPDATE document_deliveries SET status='FAILED'", delivery.runCommercialDocumentDeliveryCycle, delivery.stopCommercialDocumentDeliveryWorker],
      ['premium-media', 'UPDATE premium_media_candidates', media.runPremiumMediaCycle, media.stopPremiumMediaWorker],
      ['company-intelligence', 'FROM workspace_records', company.runCompanyIntelligenceSweep, company.stopCompanyIntelligenceWorker],
      ['omnichannel-ai-reply', 'FROM omni_ai_reply_jobs', omnichannel.runOmnichannelAiReplyCycle, omnichannel.stopOmnichannelAiReplyWorker],
      ['google-ads-spend-reconciliation', 'UPDATE workspace_google_ads_spend_allocations a SET closure_state', googleAds.runGoogleAdsSpendReconciliationCycle, googleAds.stopGoogleAdsSpendReconciliationWorker],
      ['rate-limit-cleanup', 'DELETE FROM rate_limits', rateLimits.runRateLimitCleanupCycle, rateLimits.stopRateLimitCleanupWorker],
    ];

    for (const [workerName, pattern, runCycle, stop] of cases) {
      let releaseQuery!: () => void;
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const wait = new Promise<void>((resolve) => { releaseQuery = resolve; });
      queryGate = { pattern, entered: signalEntered, wait };
      void runCycle();
      await entered;

      let stopped = false;
      const drain = stop().then(() => { stopped = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopped, false, `${workerName} stop resolved before its active cycle`);
      releaseQuery();
      await drain;
    }
  });
});
