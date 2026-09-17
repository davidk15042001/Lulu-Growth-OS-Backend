import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/payg_billing_tests_only';
process.env.JWT_SECRET = 'payg-billing-tests-secret-0123456789';
process.env.AIRWALLEX_CLIENT_ID = 'test-client';
process.env.AIRWALLEX_API_KEY = 'test-api-key';

const { pool } = await import('../src/db/pool.js');
const { reservePaygApiCheckout } = await import('../src/modules/billing/payg-billing.repo.js');
const { getBilling } = await import('../src/modules/workspace-app/workspace-app.repo.js');
const { createKnowledgeActivation, applyKnowledgeClassification } = await import('../src/modules/onboarding/onboarding.repo.js');
const { reconcileR2Inventory, recordR2Delete, recordR2Get, recordR2Put } = await import('../src/storage/r2-metering.repo.js');
const { applyApiProviderStatus, assertApiWalletFunded, attachApiProviderPayment, createApiTopup, debitApiWallet, getApiTopup } = await import('../src/modules/api-wallet/api-wallet.repo.js');
const { createApiTopupSchema } = await import('../src/modules/api-wallet/api-wallet.validator.js');
const { reconcileUnsettledApiUsage } = await import('../src/modules/usage/usage.service.js');
const { updateWorkspaceStatus } = await import('../src/modules/admin/admin.repo.js');
const { listAutomatedTargets } = await import('../src/modules/agents/agent.repo.js');
const { listKnowledgeProductsAwaitingImages } = await import('../src/modules/premium-media/premium-media.worker.js');
const { recordAirwallexWalletReversal } = await import('../src/modules/billing/airwallex-wallet-reversal.repo.js');
const { handleWebhook, verifyAirwallexInvoiceWalletPayment } = await import('../src/modules/billing/airwallex.service.js');
const {
  applyAdSpendProviderStatus,
  assertAdSpendFunded,
  attachAdSpendProviderPayment,
  createAdBudgetAuthorization,
  createAdSpendTopup,
  releaseAdSpendReservation,
  reserveAdSpend,
} = await import('../src/modules/adspend/adspend.repo.js');
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
  it('credits invoice-funded wallets only from exact provider-processed cash transactions', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/api/v1/authentication/login')) {
        return new Response(JSON.stringify({ token: 'airwallex-test-token' }), { status: 200 });
      }
      const invoiceId = new URL(value).searchParams.get('invoice_id');
      const items = invoiceId === 'inv_exact'
        ? [{ id: 'txn_exact', invoice_id: invoiceId, type: 'PAYMENT', status: 'SUCCEEDED',
          amount: 1000, currency: 'CNY', out_of_band: false, external_id: 'int_exact' }]
        : invoiceId === 'inv_out_of_band'
          ? [{ id: 'txn_oob', invoice_id: invoiceId, type: 'PAYMENT', status: 'SUCCEEDED',
            amount: 1000, currency: 'CNY', out_of_band: true, external_id: null }]
          : invoiceId === 'inv_partial'
            ? [{ id: 'txn_partial', invoice_id: invoiceId, type: 'PAYMENT', status: 'SUCCEEDED',
              amount: 999.99, currency: 'CNY', out_of_band: false, external_id: 'int_partial' }]
            : [
              { id: 'txn_paid', invoice_id: invoiceId, type: 'PAYMENT', status: 'SUCCEEDED',
                amount: 1100, currency: 'CNY', out_of_band: false, external_id: 'int_net' },
              { id: 'txn_refund', invoice_id: invoiceId, type: 'REFUND', status: 'SUCCEEDED',
                amount: 100, currency: 'CNY', out_of_band: false, external_id: 'int_net' },
            ];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });

    const exact = await verifyAirwallexInvoiceWalletPayment({ invoiceId: 'inv_exact', expectedAmount: 1000 });
    const outOfBand = await verifyAirwallexInvoiceWalletPayment({ invoiceId: 'inv_out_of_band', expectedAmount: 1000 });
    const partial = await verifyAirwallexInvoiceWalletPayment({ invoiceId: 'inv_partial', expectedAmount: 1000 });
    const net = await verifyAirwallexInvoiceWalletPayment({ invoiceId: 'inv_net_refund', expectedAmount: 1000 });

    assert.equal(exact.verified, true);
    assert.equal(exact.paymentIntentId, 'int_exact');
    assert.equal(outOfBand.verified, false);
    assert.equal(outOfBand.reason, 'out_of_band_not_accepted');
    assert.equal(partial.verified, false);
    assert.equal(partial.reason, 'cash_payment_pending');
    assert.equal(net.verified, true);
    assert.equal(net.netAmount, 1000);
  });

  it('turns Airwallex transport failures into an explicit provider error', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
    await assert.rejects(
      verifyAirwallexInvoiceWalletPayment({ invoiceId: 'inv_network_failure', expectedAmount: 1000 }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'AIRWALLEX_AUTHENTICATION_NETWORK_ERROR'),
    );
  });

  it('keeps paid invoice webhooks pending until cash proof exists', async (t) => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by) VALUES('Invoice Proof Workspace',$1) RETURNING id`,
      [user.id],
    )).rows[0]!;
    const unproven = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1000, paymentMethod: 'card' });
    const proven = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 2500, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: unproven.id, status: 'PENDING_PAYMENT', providerInvoiceId: 'inv_unproven' });
    await attachApiProviderPayment({ topupId: proven.id, status: 'PENDING_PAYMENT', providerInvoiceId: 'inv_proven' });

    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/api/v1/authentication/login')) {
        return new Response(JSON.stringify({ token: 'airwallex-test-token' }), { status: 200 });
      }
      const invoiceId = new URL(value).searchParams.get('invoice_id');
      const amount = invoiceId === 'inv_proven' ? 2500 : 1000;
      return new Response(JSON.stringify({ items: [{
        id: `txn_${invoiceId}`,
        invoice_id: invoiceId,
        type: 'PAYMENT',
        status: 'SUCCEEDED',
        amount,
        currency: 'CNY',
        out_of_band: invoiceId !== 'inv_proven',
        external_id: invoiceId === 'inv_proven' ? 'int_proven' : null,
      }] }), { status: 200 });
    });

    await handleWebhook({ id: 'evt_invoice_unproven', name: 'invoice.paid', data: { object: {
      id: 'inv_unproven', payment_status: 'PAID', paid_at: '2026-09-13T12:00:00.000Z',
      metadata: { workspace_id: workspace.id, api_wallet_topup_id: unproven.id },
    } } });
    assert.equal((await getApiTopup(workspace.id, unproven.id))?.status, 'PENDING_PAYMENT');
    assert.equal((await db.query(`SELECT workspace_id FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id])).rows.length, 0);

    await handleWebhook({ id: 'evt_invoice_proven', name: 'invoice.paid', data: { object: {
      id: 'inv_proven', payment_status: 'PAID', paid_at: '2026-09-13T12:01:00.000Z',
      metadata: { workspace_id: workspace.id, api_wallet_topup_id: proven.id },
    } } });
    assert.equal((await getApiTopup(workspace.id, proven.id))?.status, 'SUCCEEDED');
    const wallet = (await db.query<{ available: string }>(
      `SELECT available_amount AS available FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(wallet.available), 2500);
  });

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
    assert.equal(createApiTopupSchema.safeParse({ amount: 1, currency: 'CNY', paymentMethod: 'card', returnUrl: 'https://lulu-ai.cn/app' }).success, true);
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
    const reversed = (await db.query<{ available: string; debt: string; funded: string; status: string }>(
      `SELECT w.available_amount AS available,w.reversal_debt_amount AS debt,w.total_funded_amount AS funded,t.status
       FROM workspace_api_wallets w JOIN workspace_api_topups t ON t.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(reversed.available), 0);
    assert.equal(Number(reversed.debt), 7.2);
    assert.equal(Number(reversed.funded), 0);
    assert.equal(reversed.status, 'REFUNDED');

    await assert.rejects(
      () => assertApiWalletFunded(workspace.id),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'AI_REVERSAL_DEBT'),
    );
    const recovery = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1000, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: recovery.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_test_wallet_recovery' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_test_wallet_recovery', providerStatus: 'SUCCEEDED' });
    const recovered = await assertApiWalletFunded(workspace.id);
    assert.equal(recovered.availableAmount, 992.8);
    assert.equal(recovered.reversalDebtAmount, 0);

    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_test_wallet', providerStatus: 'REFUNDED' });
    const replayed = (await db.query<{ available: string; debt: string }>(
      `SELECT available_amount AS available,reversal_debt_amount AS debt
       FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(replayed.available), 992.8);
    assert.equal(Number(replayed.debt), 0);
  });

  it('records concurrent AI overage as debt and repairs an unsettled usage row', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by) VALUES('AI Settlement Workspace',$1) RETURNING id`,
      [user.id],
    )).rows[0]!;
    const topup = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_ai_overage' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_ai_overage', providerStatus: 'SUCCEEDED' });
    const usage = (await db.query<{ id: string }>(
      `INSERT INTO ai_usage_ledger(workspace_id,user_id,provider,model,customer_cost_usd,metadata)
       VALUES($1,$2,'openai','test-model',1,'{"responseId":"resp_overage"}'::jsonb) RETURNING id`,
      [workspace.id,user.id],
    )).rows[0]!;
    await debitApiWallet({ workspaceId: workspace.id, usageLedgerId: usage.id, customerCostUsd: 1, responseId: 'resp_overage', usdCnyRate: 7.2 });
    await debitApiWallet({ workspaceId: workspace.id, usageLedgerId: usage.id, customerCostUsd: 1, responseId: 'resp_overage', usdCnyRate: 7.2 });
    const exhausted = (await db.query<{ available:string;spent:string;debt:string }>(
      `SELECT available_amount AS available,spent_amount AS spent,reversal_debt_amount AS debt
         FROM workspace_api_wallets WHERE workspace_id=$1`,[workspace.id],
    )).rows[0]!;
    assert.equal(Number(exhausted.available),0);
    assert.equal(Number(exhausted.spent),7.2);
    assert.equal(Number(exhausted.debt),6.2);

    const recovery = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1000, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: recovery.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_ai_overage_recovery' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_ai_overage_recovery', providerStatus: 'SUCCEEDED' });
    await db.query(
      `INSERT INTO ai_usage_ledger(workspace_id,user_id,provider,model,customer_cost_usd,metadata)
       VALUES($1,$2,'openai','test-model',0.5,'{"responseId":"resp_unsettled"}'::jsonb)`,
      [workspace.id,user.id],
    );
    const repaired=await reconcileUnsettledApiUsage();
    assert.ok(repaired.settled>=1);
    const recovered = (await db.query<{ available:string;debt:string }>(
      `SELECT available_amount AS available,reversal_debt_amount AS debt
         FROM workspace_api_wallets WHERE workspace_id=$1`,[workspace.id],
    )).rows[0]!;
    assert.equal(Number(recovered.debt),0);
    assert.equal(Number(recovered.available),990.2);
  });

  it('preserves unrelated reservations and settles reversal debt before advertising resumes', async () => {
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
    const authorization = await createAdBudgetAuthorization({ workspaceId: workspace.id, userId: user.id,
      provider: 'google-ads', accountId: '1234567890', campaignId: '987654321', currency: 'CNY', amount: 200,
      startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      idempotencyKey: 'authorize-before-chargeback' });
    const reservation = await reserveAdSpend({ workspaceId: workspace.id, authorizationId: authorization.id, amount: 100,
      provider: 'google-ads', accountId: '1234567890', campaignId: '987654321', currency: 'CNY', idempotencyKey: 'reserve-before-chargeback' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_reversal', providerStatus: 'CHARGEBACK' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_reversal', providerStatus: 'SUCCEEDED' });
    const state = (await db.query<{ available: string; reserved: string; debt: string; status: string; reservationStatus: string }>(
      `SELECT w.available_amount AS available,w.reserved_amount AS reserved,w.reversal_debt_amount AS debt,t.status,
              r.status AS "reservationStatus"
       FROM workspace_ad_spend_wallets w
       JOIN workspace_ad_spend_topups t ON t.workspace_id=w.workspace_id
       JOIN workspace_ad_spend_reservations r ON r.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(state.available), 0);
    assert.equal(Number(state.reserved), 100);
    assert.equal(Number(state.debt), 100);
    assert.equal(state.status, 'CHARGEBACK');
    assert.equal(state.reservationStatus, 'RESERVED');

    await assert.rejects(
      () => assertAdSpendFunded(workspace.id),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'AD_SPEND_REVERSAL_DEBT'),
    );
    await assert.rejects(
      () => reserveAdSpend({ workspaceId: workspace.id, authorizationId: authorization.id, amount: 1,
        provider: 'google-ads', accountId: '1234567890', campaignId: '987654321', currency: 'CNY', idempotencyKey: 'blocked-by-chargeback-debt' }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'AD_SPEND_REVERSAL_DEBT'),
    );

    const recoveryTopup = await createAdSpendTopup({ workspaceId: workspace.id, userId: user.id,
      netAmount: 50, feeAmount: 2, totalAmount: 52, paymentMethod: 'card' });
    await attachAdSpendProviderPayment({ topupId: recoveryTopup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_ad_recovery' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_recovery', providerStatus: 'SUCCEEDED' });
    const partiallyRecovered = (await db.query<{ available: string; debt: string }>(
      `SELECT available_amount AS available,reversal_debt_amount AS debt
       FROM workspace_ad_spend_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(partiallyRecovered.available), 0);
    assert.equal(Number(partiallyRecovered.debt), 50);

    await releaseAdSpendReservation({ workspaceId: workspace.id, reservationId: reservation.id,
      reason: 'Provider rejected the campaign operation' });
    const recovered = (await db.query<{ available: string; reserved: string; debt: string; reservationStatus: string }>(
      `SELECT w.available_amount AS available,w.reserved_amount AS reserved,w.reversal_debt_amount AS debt,
              r.status AS "reservationStatus"
       FROM workspace_ad_spend_wallets w
       JOIN workspace_ad_spend_reservations r ON r.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1 AND r.id=$2`, [workspace.id, reservation.id],
    )).rows[0]!;
    assert.equal(Number(recovered.available), 50);
    assert.equal(Number(recovered.reserved), 0);
    assert.equal(Number(recovered.debt), 0);
    assert.equal(recovered.reservationStatus, 'RELEASED');

    const resumed = await reserveAdSpend({ workspaceId: workspace.id, authorizationId: authorization.id, amount: 25,
      provider: 'google-ads', accountId: '1234567890', campaignId: '987654321', currency: 'CNY', idempotencyKey: 'reserve-after-debt-settled' });
    assert.equal(resumed.status, 'RESERVED');
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'pi_ad_reversal', providerStatus: 'CHARGEBACK' });
    const replayed = (await db.query<{ debt: string; refunded: string }>(
      `SELECT reversal_debt_amount AS debt,refunded_amount AS refunded
       FROM workspace_ad_spend_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(replayed.debt), 0);
    assert.equal(Number(replayed.refunded), 10_000);
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

    await db.query(
      `INSERT INTO workspace_subscriptions(workspace_id,provider,plan_key,status)
       VALUES($1,'internal','starter','cancelled')`,
      [workspace.id],
    );
    await db.query(`UPDATE workspaces SET profile_completed_at=NOW(),knowledge_base_completed_at=NOW(),onboarding_completed_at=NOW(),onboarding_step='setup_complete' WHERE id=$1`, [workspace.id]);
    assert.equal(
      (await listAutomatedTargets()).some((item) => item.workspace_id === workspace.id),
      false,
      'billing skip never turns an internal subscription into free AI funding',
    );
    const topup = await createApiTopup({ workspaceId: workspace.id, userId: owner.id, amount: 1000, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'pi_skipped_workspace' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'pi_skipped_workspace', providerStatus: 'SUCCEEDED' });
    const target = (await listAutomatedTargets()).find((item) => item.workspace_id === workspace.id);
    assert.equal(target?.status, 'billing_skipped');
    assert.equal(target?.plan_key, 'ai');
  });

  it('journals exact partial AI refunds and idempotent dispute releases', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by) VALUES('Partial AI Reversal',$1) RETURNING id`, [user.id],
    )).rows[0]!;
    const topup = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1000, paymentMethod: 'card' });
    await attachApiProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'int_partial_ai' });
    await applyApiProviderStatus({ providerPaymentIntentId: 'int_partial_ai', providerStatus: 'SUCCEEDED' });

    const first = await recordAirwallexWalletReversal({
      eventId: 'evt_partial_ai_1', eventType: 'refund.settled', reversalKind: 'REFUND',
      reversalId: 'rfd_partial_ai_1', providerStatus: 'SETTLED', active: true, amount: 125.25,
      currency: 'CNY', providerPaymentIntentId: 'int_partial_ai',
      providerUpdatedAt: '2026-09-13T08:00:00.000Z', eventCreatedAt: '2026-09-13T08:00:01.000Z',
    });
    const replay = await recordAirwallexWalletReversal({
      eventId: 'evt_partial_ai_1_replay', eventType: 'refund.settled', reversalKind: 'REFUND',
      reversalId: 'rfd_partial_ai_1', providerStatus: 'SETTLED', active: true, amount: 125.25,
      currency: 'CNY', providerPaymentIntentId: 'int_partial_ai',
      providerUpdatedAt: '2026-09-13T08:00:00.000Z', eventCreatedAt: '2026-09-13T08:00:02.000Z',
    });
    await recordAirwallexWalletReversal({
      eventId: 'evt_partial_ai_2', eventType: 'refund.settled', reversalKind: 'REFUND',
      reversalId: 'rfd_partial_ai_2', providerStatus: 'SETTLED', active: true, amount: 74.75,
      currency: 'CNY', providerPaymentIntentId: 'int_partial_ai',
      providerUpdatedAt: '2026-09-13T08:01:00.000Z', eventCreatedAt: '2026-09-13T08:01:01.000Z',
    });
    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);

    await handleWebhook({ id: 'evt_dispute_lost', name: 'payment_dispute.lost', created_at: '2026-09-13T08:02:01.000Z',
      data: { object: { dispute_id: 'dst_partial_ai', payment_intent_id: 'int_partial_ai', stage: 'DISPUTE',
        dispute_amount: 50, dispute_currency: 'CNY', updated_at: '2026-09-13T08:02:00.000Z' } } });
    await handleWebhook({ id: 'evt_dispute_won', name: 'payment_dispute.won', created_at: '2026-09-13T08:03:01.000Z',
      data: { object: { dispute_id: 'dst_partial_ai', payment_intent_id: 'int_partial_ai', stage: 'DISPUTE',
        dispute_amount: 50, dispute_currency: 'CNY', updated_at: '2026-09-13T08:03:00.000Z' } } });
    const stale = await handleWebhook({ id: 'evt_dispute_stale_lost', name: 'payment_dispute.lost', created_at: '2026-09-13T08:04:01.000Z',
      data: { object: { dispute_id: 'dst_partial_ai', payment_intent_id: 'int_partial_ai', stage: 'DISPUTE',
        dispute_amount: 50, dispute_currency: 'CNY', updated_at: '2026-09-13T08:02:00.000Z' } } });
    assert.equal(stale.stale, true);

    const wallet = (await db.query<{ available: string; funded: string; debt: string }>(
      `SELECT available_amount AS available,total_funded_amount AS funded,reversal_debt_amount AS debt
       FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.equal(Number(wallet.available), 800);
    assert.equal(Number(wallet.funded), 800);
    assert.equal(Number(wallet.debt), 0);
    const journal = await db.query<{ kind: string; providerAmount: string; applied: string; sequence: number }>(
      `SELECT provider_reversal_kind AS kind,provider_amount AS "providerAmount",
         applied_wallet_amount AS applied,movement_sequence AS sequence
       FROM airwallex_wallet_reversals WHERE api_topup_id=$1 ORDER BY provider_reversal_id`, [topup.id],
    );
    assert.equal(journal.rows.length, 3);
    assert.equal(journal.rows.filter((row) => row.kind === 'REFUND').reduce((sum, row) => sum + Number(row.providerAmount), 0), 200);
    const dispute = journal.rows.find((row) => row.kind === 'DISPUTE')!;
    assert.equal(Number(dispute.applied), 0);
    assert.equal(dispute.sequence, 2);
  });

  it('splits partial advertising refunds exactly between budget and the four-percent fee', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by) VALUES('Partial Ad Reversal',$1) RETURNING id`, [user.id],
    )).rows[0]!;
    const topup = await createAdSpendTopup({ workspaceId: workspace.id, userId: user.id,
      netAmount: 10_000, feeAmount: 400, totalAmount: 10_400, paymentMethod: 'card' });
    await attachAdSpendProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: 'int_partial_ad' });
    await applyAdSpendProviderStatus({ providerPaymentIntentId: 'int_partial_ad', providerStatus: 'SUCCEEDED' });

    await recordAirwallexWalletReversal({
      eventId: 'evt_partial_ad_1', eventType: 'refund.settled', reversalKind: 'REFUND',
      reversalId: 'rfd_partial_ad_1', providerStatus: 'SETTLED', active: true, amount: 5200,
      currency: 'CNY', providerPaymentIntentId: 'int_partial_ad', providerUpdatedAt: '2026-09-13T09:00:00.000Z',
    });
    let wallet = (await db.query<{ available: string; funded: string; fee: string; refunded: string }>(
      `SELECT available_amount AS available,total_funded_amount AS funded,total_fee_amount AS fee,
         refunded_amount AS refunded FROM workspace_ad_spend_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.deepEqual([Number(wallet.available), Number(wallet.funded), Number(wallet.fee), Number(wallet.refunded)], [5000, 5000, 200, 5000]);

    await recordAirwallexWalletReversal({
      eventId: 'evt_partial_ad_2', eventType: 'refund.settled', reversalKind: 'REFUND',
      reversalId: 'rfd_partial_ad_2', providerStatus: 'SETTLED', active: true, amount: 5200,
      currency: 'CNY', providerPaymentIntentId: 'int_partial_ad', providerUpdatedAt: '2026-09-13T09:01:00.000Z',
    });
    wallet = (await db.query<{ available: string; funded: string; fee: string; refunded: string }>(
      `SELECT available_amount AS available,total_funded_amount AS funded,total_fee_amount AS fee,
         refunded_amount AS refunded FROM workspace_ad_spend_wallets WHERE workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.deepEqual([Number(wallet.available), Number(wallet.funded), Number(wallet.fee), Number(wallet.refunded)], [0, 0, 0, 10_000]);
    const state = (await db.query<{ status: string; provider: string; wallet: string; fee: string }>(
      `SELECT t.status,r.provider_amount AS provider,r.wallet_amount AS wallet,r.fee_amount AS fee
       FROM workspace_ad_spend_topups t JOIN airwallex_wallet_reversals r ON r.ad_spend_topup_id=t.id
       WHERE t.id=$1 ORDER BY r.provider_reversal_id LIMIT 1`, [topup.id],
    )).rows[0]!;
    assert.deepEqual([state.status, Number(state.provider), Number(state.wallet), Number(state.fee)], ['REFUNDED', 5200, 5000, 200]);
  });

  it('applies a terminal refund received before payment success and keeps unknown or unmatched events retryable', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by) VALUES('Out Of Order Reversal',$1) RETURNING id`, [user.id],
    )).rows[0]!;
    const topup = await createApiTopup({ workspaceId: workspace.id, userId: user.id, amount: 1000, paymentMethod: 'wechatpay' });

    const received = await handleWebhook({ id: 'evt_pending_refund_received', name: 'refund.received',
      created_at: '2026-09-13T10:00:00.000Z', data: { object: { id: 'rfd_pending_ai',
        payment_intent_id: 'int_pending_ai', amount: 250, currency: 'CNY', status: 'RECEIVED',
        metadata: { workspace_id: workspace.id, api_wallet_topup_id: topup.id }, updated_at: '2026-09-13T10:00:00.000Z' } } });
    assert.equal(received.ignored, true);
    assert.equal((await db.query(`SELECT id FROM airwallex_wallet_reversals WHERE api_topup_id=$1`, [topup.id])).rows.length, 0);
    const accepted = await handleWebhook({ id: 'evt_pending_refund_accepted', name: 'refund.accepted',
      created_at: '2026-09-13T10:00:30.000Z', data: { object: { id: 'rfd_pending_ai',
        payment_intent_id: 'int_pending_ai', amount: 250, currency: 'CNY', status: 'ACCEPTED',
        metadata: { workspace_id: workspace.id, api_wallet_topup_id: topup.id }, updated_at: '2026-09-13T10:00:30.000Z' } } });
    assert.equal(accepted.ignored, true);
    assert.equal((await db.query(`SELECT id FROM airwallex_wallet_reversals WHERE api_topup_id=$1`, [topup.id])).rows.length, 0);

    await handleWebhook({ id: 'evt_pending_refund_settled', name: 'refund.settled',
      created_at: '2026-09-13T10:01:01.000Z', data: { object: { id: 'rfd_pending_ai',
        payment_intent_id: 'int_pending_ai', amount: 250, currency: 'CNY', status: 'SETTLED',
        metadata: { workspace_id: workspace.id, api_wallet_topup_id: topup.id }, updated_at: '2026-09-13T10:01:00.000Z' } } });
    assert.equal((await db.query(`SELECT workspace_id FROM workspace_api_wallets WHERE workspace_id=$1`, [workspace.id])).rows.length, 0);
    await applyApiProviderStatus({ providerPaymentIntentId: 'int_pending_ai', providerStatus: 'SUCCEEDED' });
    const wallet = (await db.query<{ available: string; funded: string; applied: string }>(
      `SELECT w.available_amount AS available,w.total_funded_amount AS funded,r.applied_wallet_amount AS applied
       FROM workspace_api_wallets w JOIN airwallex_wallet_reversals r ON r.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.deepEqual([Number(wallet.available), Number(wallet.funded), Number(wallet.applied)], [750, 750, 250]);

    await assert.rejects(
      () => handleWebhook({ id: 'evt_unknown_refund', name: 'refund.completed', data: { object: {} } }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'AIRWALLEX_REFUND_EVENT_UNSUPPORTED'),
    );
    await assert.rejects(
      () => handleWebhook({ id: 'evt_unmatched_refund', name: 'refund.settled', data: { object: {
        id: 'rfd_not_found', payment_intent_id: 'int_not_found', amount: 10, currency: 'CNY', status: 'SETTLED',
        updated_at: '2026-09-13T10:02:00.000Z',
      } } }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'AIRWALLEX_WALLET_TOPUP_NOT_FOUND'),
    );
    const failedEvents = await db.query<{ eventId: string; processedAt: string | null; errorCode: string | null }>(
      `SELECT event_id AS "eventId",processed_at AS "processedAt",last_error_code AS "errorCode"
       FROM airwallex_webhook_events WHERE event_id IN ('evt_unknown_refund','evt_unmatched_refund') ORDER BY event_id`,
    );
    assert.equal(failedEvents.rows.every((row) => row.processedAt === null), true);
    assert.deepEqual(failedEvents.rows.map((row) => row.errorCode),
      ['AIRWALLEX_REFUND_EVENT_UNSUPPORTED', 'AIRWALLEX_WALLET_TOPUP_NOT_FOUND']);
  });
});
