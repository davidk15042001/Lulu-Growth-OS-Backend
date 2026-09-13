import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/premium_media_billing_tests_only';
process.env.JWT_SECRET = 'premium-media-billing-tests-secret-0123456789';

const { pool } = await import('../src/db/pool.js');
const reservations = await import('../src/modules/api-wallet/ai-spend-reservation.repo.js');
const mediaRepo = await import('../src/modules/premium-media/premium-media.repo.js');
const { recordCandidateProviderUsage } = await import('../src/modules/premium-media/premium-media.service.js');
const { resolveKieMaximumCreditVariant, maximumKieCustomerCostUsd } = await import('../src/modules/premium-media/premium-media-cost-catalog.js');
const { env } = await import('../src/config/env.js');

const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({
    query: execute,
    release() {},
  })) as never);
});

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

async function fixture() {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
    [`${crypto.randomUUID()}@test.local`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES($1,$2) RETURNING id`,
    [`Media ${crypto.randomUUID()}`, userId],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId]);
  await db.query(
    `INSERT INTO workspace_subscriptions(workspace_id,provider,plan_key,status) VALUES($1,'airwallex','starter','active')`,
    [workspaceId],
  );
  await db.query(
    `INSERT INTO workspace_api_wallets(workspace_id,available_amount,total_funded_amount) VALUES($1,100,100)`,
    [workspaceId],
  );
  const productId = (await db.query<{ id: string }>(
    `INSERT INTO products(workspace_id,status,product_type,name,pricing_type,created_by)
     VALUES($1,'ACTIVE','PHYSICAL_PRODUCT','Premium test product','FIXED',$2) RETURNING id`,
    [workspaceId, userId],
  )).rows[0]!.id;
  const job = await mediaRepo.createJob({
    workspaceId,
    productId,
    requestedBy: userId,
    aspectRatio: '1:1',
    referenceAssets: [],
    deliverImage: true,
    deliverVideo: false,
    maxRounds: 3,
    imageQualityThreshold: 92,
    videoQualityThreshold: 90,
  });
  const created = await mediaRepo.createCandidate({
    job,
    purpose: 'IMAGE_GENERATION',
    mediaType: 'IMAGE',
    model: 'flux-2/pro-text-to-image',
    providerApi: 'MARKET',
    generationRound: 1,
    prompt: 'A premium product photograph',
    referenceUrls: [],
  });
  return { userId, workspaceId, job, candidate: created.candidate };
}

async function reserveAndSubmit(input: Awaited<ReturnType<typeof fixture>>, providerTaskId: string) {
  const variant = resolveKieMaximumCreditVariant({
    purpose: 'IMAGE_GENERATION',
    model: input.candidate.model,
    resolution: env.KIE_IMAGE_RESOLUTION,
  });
  const reserved = await reservations.reserveAiSpend({
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestKey: `premium-media:${input.candidate.id}:provider:v1`,
    requestFingerprint: reservations.fingerprintAiRequest({ candidateId: input.candidate.id, variant }),
    operation: 'premium_media.image_generation',
    maximumCustomerCostUsd: maximumKieCustomerCostUsd(variant),
    usdCnyRate: env.API_USD_CNY_RATE,
    pricingSnapshot: { maximumCredits: variant.maximumCredits },
    provider: 'kie.ai',
    model: input.candidate.model,
  });
  assert.ok(reserved.reservation);
  const bound = await mediaRepo.bindCandidateProviderFunding({
    workspaceId: input.workspaceId,
    candidateId: input.candidate.id,
    reservationId: reserved.reservation.id,
    fundingMode: 'CUSTOMER_PREPAID',
    variant,
  });
  assert.ok(bound);
  assert.ok(await mediaRepo.markCandidateSubmissionStarted(input.workspaceId, input.candidate.id));
  assert.ok(await reservations.markAiSpendSubmitting(input.workspaceId, reserved.reservation.id));
  assert.ok(await mediaRepo.markCandidateSubmitted(input.workspaceId, input.candidate.id, providerTaskId, {}));
  assert.ok(await reservations.markAiSpendSubmitted({
    workspaceId: input.workspaceId,
    reservationId: reserved.reservation.id,
    provider: 'kie.ai',
    model: input.candidate.model,
    providerRequestId: providerTaskId,
  }));
  return reserved.reservation;
}

describe('premium media prepaid billing', () => {
  it('settles exact Kie credits exactly once against the durable hold', async () => {
    const seeded = await fixture();
    await reserveAndSubmit(seeded, 'kie-premium-exact-1');
    const terminal = await mediaRepo.applyProviderResult({
      candidateId: seeded.candidate.id,
      providerTaskId: 'kie-premium-exact-1',
      state: 'success',
      resultUrls: ['https://example.test/result.png'],
      creditsConsumed: 10,
      payload: { creditsConsumed: 10 },
    });
    assert.ok(terminal);
    await recordCandidateProviderUsage(terminal);
    const settled = (await mediaRepo.listCandidates(seeded.workspaceId, seeded.job.id))[0]!;
    assert.equal(settled.providerSubmissionState, 'SETTLED');
    assert.equal(settled.usageRecorded, true);
    await recordCandidateProviderUsage(settled);

    const wallet = (await db.query<{ available: string; reserved: string; spent: string }>(
      `SELECT available_amount AS available,reserved_amount AS reserved,spent_amount AS spent
         FROM workspace_api_wallets WHERE workspace_id=$1`,
      [seeded.workspaceId],
    )).rows[0]!;
    assert.equal(Number(wallet.reserved), 0);
    assert.equal(Number(wallet.spent), 0.72);
    assert.equal(Number(wallet.available), 99.28);
    const usageCount = (await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_usage_ledger WHERE workspace_id=$1 AND provider='kie.ai'`,
      [seeded.workspaceId],
    )).rows[0]!.count;
    assert.equal(Number(usageCount), 1);
    const claimed = await mediaRepo.claimCandidateForProcessing('premium-billing-test-worker', 5);
    assert.equal(claimed?.id, seeded.candidate.id);
    assert.equal(claimed?.status, 'PROCESSING');
  });

  it('retains the prepaid hold when a terminal Kie result lacks exact positive credits', async () => {
    const seeded = await fixture();
    const reservation = await reserveAndSubmit(seeded, 'kie-premium-missing-credits');
    const terminal = await mediaRepo.applyProviderResult({
      candidateId: seeded.candidate.id,
      providerTaskId: 'kie-premium-missing-credits',
      state: 'success',
      resultUrls: ['https://example.test/result.png'],
      creditsConsumed: null,
      payload: {},
    });
    assert.ok(terminal);
    assert.equal(terminal.providerSubmissionState, 'AMBIGUOUS');
    await recordCandidateProviderUsage(terminal);
    const wallet = (await db.query<{ reserved: string }>(
      `SELECT reserved_amount AS reserved FROM workspace_api_wallets WHERE workspace_id=$1`,
      [seeded.workspaceId],
    )).rows[0]!;
    assert.ok(Number(wallet.reserved) > 0);
    const persistedReservation = (await db.query<{ status: string }>(
      `SELECT status FROM ai_spend_reservations WHERE workspace_id=$1 AND id=$2`,
      [seeded.workspaceId, reservation.id],
    )).rows[0]!;
    assert.equal(persistedReservation.status, 'AMBIGUOUS');
    assert.equal((await mediaRepo.getPremiumMediaBillingHealth()).ambiguousCount >= 1, true);
  });
});
