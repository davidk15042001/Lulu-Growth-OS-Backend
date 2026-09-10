import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/payg_billing_tests_only';
process.env.JWT_SECRET = 'payg-billing-tests-secret-0123456789';

const { pool } = await import('../src/db/pool.js');
const { reservePaygApiCheckout } = await import('../src/modules/billing/payg-billing.repo.js');
const { getBilling } = await import('../src/modules/workspace-app/workspace-app.repo.js');
const { createKnowledgeActivation, applyKnowledgeClassification } = await import('../src/modules/onboarding/onboarding.repo.js');
const { reconcileR2Inventory, recordR2Delete, recordR2Get, recordR2Put } = await import('../src/storage/r2-metering.repo.js');
const { applyApiProviderStatus, attachApiProviderPayment, createApiTopup, debitApiWallet } = await import('../src/modules/api-wallet/api-wallet.repo.js');
const { createApiTopupSchema } = await import('../src/modules/api-wallet/api-wallet.validator.js');
const { updateWorkspaceStatus } = await import('../src/modules/admin/admin.repo.js');
const { listAutomatedTargets } = await import('../src/modules/agents/agent.repo.js');
const { listKnowledgeProductsAwaitingImages } = await import('../src/modules/premium-media/premium-media.worker.js');
const { applyAdSpendProviderStatus, attachAdSpendProviderPayment, createAdSpendTopup, reserveAdSpend } = await import('../src/modules/adspend/adspend.repo.js');
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

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

describe('prepaid API and transparent usage reporting', () => {
  it('rejects the retired API PAYG reservation without mutating usage', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Internal AI Workspace', $1) RETURNING id`,
      [user.id],
    )).rows[0]!;
    await db.query(
      `INSERT INTO workspace_subscriptions(workspace_id, provider, plan_key, status)
       VALUES($1, 'internal', 'ai', 'trialing')`,
      [workspace.id],
    );
    await db.query(
      `INSERT INTO workspace_payg_profiles(
         workspace_id, interval_days, current_period_start, current_period_end,
         preferred_payment_method, payment_method_configured_at
       ) VALUES($1, 7, NOW() - INTERVAL '1 day', NOW() + INTERVAL '6 days', 'wechatpay', NOW())`,
      [workspace.id],
    );
    await db.query(
      `INSERT INTO ai_usage_ledger(
         workspace_id, user_id, provider, model, input_tokens, output_tokens, customer_cost_usd
       ) VALUES($1, $2, 'alibaba', 'deepseek-v4-pro', 1000, 500, 0.25)`,
      [workspace.id, user.id],
    );

    await assert.rejects(
      reservePaygApiCheckout(workspace.id, { requireBillingCustomer: false }),
      (error: unknown) => Boolean(error && typeof error === 'object'
        && 'code' in error && error.code === 'API_PREPAID_REQUIRED'
        && 'status' in error && error.status === 410),
    );
    const ledger = await db.query<{ paygPeriodId: string | null }>(
      `SELECT payg_period_id AS "paygPeriodId" FROM ai_usage_ledger WHERE workspace_id=$1`,
      [workspace.id],
    );
    assert.equal(ledger.rows[0]?.paygPeriodId, null);
  });

  it('returns transparent premium-media rates and per-model usage costs', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Media Usage Workspace', $1) RETURNING id`,
      [user.id],
    )).rows[0]!;
    await db.query(
      `INSERT INTO workspace_subscriptions(workspace_id, provider, plan_key, status)
       VALUES($1, 'internal', 'ai', 'trialing')`,
      [workspace.id],
    );
    await db.query(
      `INSERT INTO workspace_payg_profiles(
         workspace_id, interval_days, current_period_start, current_period_end,
         preferred_payment_method, payment_method_configured_at
       ) VALUES($1, 7, NOW() - INTERVAL '1 day', NOW() + INTERVAL '6 days', 'card', NOW())`,
      [workspace.id],
    );
    await db.query(
      `INSERT INTO ai_usage_ledger(
         workspace_id, user_id, provider, model, provider_cost_usd, customer_cost_usd, metadata
       ) VALUES($1, $2, 'kie.ai', 'kling/v3-turbo-image-to-video', 0.125, 0.25,
         '{"creditsConsumed":25,"operation":"video_generation"}'::jsonb)`,
      [workspace.id, user.id],
    );

    const billing = await getBilling(workspace.id, user.id, {});
    assert.equal(billing.payg?.pricing.premiumMediaPerKieCreditUsd, 0.01);
    assert.equal(billing.payg?.usageBreakdown.length, 1);
    assert.deepEqual(billing.payg?.usageBreakdown[0], {
      provider: 'kie.ai',
      model: 'kling/v3-turbo-image-to-video',
      operation: 'video_generation',
      events: 1,
      inputTokens: 0,
      outputTokens: 0,
      kieCredits: 25,
      customerCost: 0.25,
    });
  });

  it('stores services as offerings, creates only real products, and completes activation', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by, onboarding_step, profile_completed_at)
       VALUES('Activation Workspace', $1, 'knowledge_base', NOW()) RETURNING id`,
      [user.id],
    )).rows[0]!;
    const activationId = await createKnowledgeActivation({
      workspaceId: workspace.id, userId: user.id, text: 'Products and consulting', documentIds: [], model: 'test-model',
    });
    const existingProduct = (await db.query<{ id: string }>(
      `INSERT INTO products(workspace_id,status,product_type,name,pricing_type,visibility,source_language,created_by)
       VALUES($1,'DRAFT','PHYSICAL_PRODUCT','Existing Device','QUOTE_REQUIRED','PRIVATE','en',$2) RETURNING id`,
      [workspace.id, user.id],
    )).rows[0]!;
    await db.query(
      `INSERT INTO product_media(workspace_id,product_id,media_type,storage_reference)
       VALUES($1,$2,'IMAGE','existing/product.png')`,
      [workspace.id, existingProduct.id],
    );

    const result = await applyKnowledgeClassification({
      activationId, workspaceId: workspace.id, userId: user.id,
      classification: { generalKnowledge: [{ title: 'Mission', content: 'Build trust.' }] },
      summary: 'A product and consulting company.', businessDescription: 'A product and consulting company.',
      items: [
        { name: 'Premium Device', kind: 'product', productType: 'PHYSICAL_PRODUCT', description: 'A device.', category: 'Hardware', price: 500, currency: 'CNY' },
        { name: 'Existing Device', kind: 'product', productType: 'PHYSICAL_PRODUCT', description: 'Already pictured.', category: 'Hardware', price: null, currency: null },
        { name: 'Strategy Consulting', kind: 'service', productType: null, description: 'Consulting.', category: 'Services', price: null, currency: null },
        { name: 'Trusted since launch', kind: 'other', productType: null, description: 'General fact.', category: null, price: null, currency: null },
      ],
    });

    assert.equal(result.productIds.length, 2);
    assert.equal(result.missingImageProductIds.length, 1);
    assert.notEqual(result.missingImageProductIds[0], existingProduct.id);
    assert.equal((await db.query(`SELECT id FROM products WHERE workspace_id=$1`, [workspace.id])).rows.length, 2);
    assert.equal((await db.query(`SELECT id FROM workspace_offerings WHERE workspace_id=$1`, [workspace.id])).rows.length, 3);
    assert.deepEqual((await listKnowledgeProductsAwaitingImages(workspace.id)).map((item) => item.id), result.missingImageProductIds);
    const state = (await db.query<{ step: string; completedAt: string | null }>(
      `SELECT onboarding_step AS step,onboarding_completed_at AS "completedAt" FROM workspaces WHERE id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(state.step, 'setup_complete');
    assert.ok(state.completedAt);
  });

  it('meters R2 storage without a free-tier deduction and records operation classes', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Storage Workspace', $1) RETURNING id`, [user.id],
    )).rows[0]!;
    const key = `workspaces/${workspace.id}/documents/one.bin`;
    await recordR2Put({ key, sizeBytes: 1_000_000_000, contentType: 'application/octet-stream' });
    await recordR2Get(key);
    const usage = (await db.query<{ classA: string; classB: string; providerCost: string; customerCost: string }>(
      `SELECT class_a_operations AS "classA",class_b_operations AS "classB",
              provider_cost_usd AS "providerCost",customer_cost_usd AS "customerCost"
       FROM workspace_r2_usage_ledger WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(usage.classA), 1);
    assert.equal(Number(usage.classB), 1);
    assert.ok(Number(usage.customerCost) > Number(usage.providerCost));
    assert.ok(Number(usage.customerCost) > 0.2 / 31);
    const staleKey = `workspaces/${workspace.id}/documents/stale.bin`;
    await db.query(
      `INSERT INTO workspace_storage_objects(object_key,workspace_id,size_bytes)
       VALUES($1,$2,10)`, [staleKey, workspace.id],
    );
    const importedKey = `workspaces/${workspace.id}/documents/imported.bin`;
    await reconcileR2Inventory([
      { key, sizeBytes: 1_000_000_000 },
      { key: importedKey, sizeBytes: 500 },
    ], new Date(Date.now() + 1_000));
    const inventory = await db.query<{ objectKey: string; deletedAt: string | null }>(
      `SELECT object_key AS "objectKey",deleted_at AS "deletedAt"
       FROM workspace_storage_objects WHERE workspace_id=$1`, [workspace.id],
    );
    assert.equal(inventory.rows.find((item) => item.objectKey === staleKey)?.deletedAt !== null, true);
    assert.equal(inventory.rows.find((item) => item.objectKey === importedKey)?.deletedAt, null);
    await recordR2Delete(key);
    const object = (await db.query<{ deletedAt: string | null }>(
      `SELECT deleted_at AS "deletedAt" FROM workspace_storage_objects WHERE object_key=$1`, [key],
    )).rows[0]!;
    assert.ok(object.deletedAt);
  });

  it('credits and debits a fixed AI package exactly once', async () => {
    assert.equal(createApiTopupSchema.safeParse({ amount: 1200, currency: 'CNY', paymentMethod: 'card', returnUrl: 'https://lulu-ai.cn/app' }).success, false);
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('AI Wallet Workspace', $1) RETURNING id`, [user.id],
    )).rows[0]!;
    const topup = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1000, paymentMethod: 'wechatpay' });
    await attachApiProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_test_wallet' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_test_wallet', providerStatus: 'SUCCEEDED' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_test_wallet', providerStatus: 'SUCCEEDED' });
    const usage = (await db.query<{ id: string }>(
      `INSERT INTO ai_usage_ledger(workspace_id,user_id,provider,model,customer_cost_usd)
       VALUES($1,$2,'openai','test-model',1) RETURNING id`, [workspace.id, user.id],
    )).rows[0]!;
    await debitApiWallet({ workspaceId: workspace.id, usageLedgerId: usage.id, customerCostUsd: 1, responseId: 'resp_once', usdCnyRate: 7.2 });
    await debitApiWallet({ workspaceId: workspace.id, usageLedgerId: usage.id, customerCostUsd: 1, responseId: 'resp_once', usdCnyRate: 7.2 });
    const wallet = (await db.query<{ available: string; spent: string; funded: string }>(
      `SELECT available_amount AS available,spent_amount AS spent,total_funded_amount AS funded
       FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(wallet.funded), 1000);
    assert.equal(Number(wallet.spent), 7.2);
    assert.equal(Number(wallet.available), 992.8);

    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_test_wallet', providerStatus: 'REFUNDED' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_test_wallet', providerStatus: 'SUCCEEDED' });
    const reversed = (await db.query<{ available: string; funded: string; status: string }>(
      `SELECT w.available_amount AS available,w.total_funded_amount AS funded,t.status
       FROM workspace_api_wallets w JOIN workspace_api_topups t ON t.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(reversed.available), 0);
    assert.equal(Number(reversed.funded), 0);
    assert.equal(reversed.status, 'REFUNDED');
  });

  it('stops advertising reservations after a provider payment reversal', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Ad Reversal Workspace', $1) RETURNING id`, [user.id],
    )).rows[0]!;
    const topup = await createAdSpendTopup({ workspaceId: workspace.id, userId: user.id,
      netAmount: 10_000, feeAmount: 400, totalAmount: 10_400, paymentMethod: 'card' });
    await attachAdSpendProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_ad_reversal' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_reversal', providerStatus: 'SUCCEEDED' });
    await reserveAdSpend({ workspaceId: workspace.id, amount: 100, idempotencyKey: 'reserve-before-chargeback' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_reversal', providerStatus: 'CHARGEBACK' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_reversal', providerStatus: 'SUCCEEDED' });
    const state = (await db.query<{ available: string; reserved: string; status: string; reservationStatus: string }>(
      `SELECT w.available_amount AS available,w.reserved_amount AS reserved,t.status,
              r.status AS "reservationStatus"
       FROM workspace_ad_spend_wallets w
       JOIN workspace_ad_spend_topups t ON t.workspace_id=w.workspace_id
       JOIN workspace_ad_spend_reservations r ON r.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(state.available), 0);
    assert.equal(Number(state.reserved), 0);
    assert.equal(state.status, 'CHARGEBACK');
    assert.equal(state.reservationStatus, 'EXPIRED');
  });

  it('audits an admin billing skip without granting a plan or wallet funds', async () => {
    const admin = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash,role) VALUES($1,'hash','admin') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const owner = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by,onboarding_step) VALUES('Skip Workspace',$1,'billing') RETURNING id`, [owner.id],
    )).rows[0]!;

    await updateWorkspaceStatus(workspace.id, 'skip-onboarding', undefined, admin.id);
    await updateWorkspaceStatus(workspace.id, 'skip-onboarding', undefined, admin.id);

    const state = (await db.query<{ step: string; skippedBy: string | null; completedAt: string | null }>(
      `SELECT onboarding_step AS step,billing_skipped_by AS "skippedBy",onboarding_completed_at AS "completedAt"
       FROM workspaces WHERE id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(state.step, 'profile_completion');
    assert.equal(state.skippedBy, admin.id);
    assert.equal(state.completedAt, null);
    assert.equal((await db.query(`SELECT workspace_id FROM workspace_subscriptions WHERE workspace_id=$1`, [workspace.id])).rows.length, 0);
    assert.equal((await db.query(`SELECT workspace_id FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id])).rows.length, 0);
    assert.equal((await db.query(`SELECT id FROM audit_log WHERE workspace_id=$1 AND action='onboarding.billing_skipped'`, [workspace.id])).rows.length, 1);

    await db.query(`UPDATE workspaces SET profile_completed_at=NOW(),knowledge_base_completed_at=NOW(),onboarding_completed_at=NOW(),onboarding_step='setup_complete' WHERE id=$1`, [workspace.id]);
    const topup = await createApiTopup({ workspaceId: workspace.id, userId: owner.id, amount: 1000, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_skipped_workspace' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_skipped_workspace', providerStatus: 'SUCCEEDED' });
    const target = (await listAutomatedTargets()).find((item) => item.workspace_id === workspace.id);
    assert.equal(target?.status, 'billing_skipped');
  });
});
