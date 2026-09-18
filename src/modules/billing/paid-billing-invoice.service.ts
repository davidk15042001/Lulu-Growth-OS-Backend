import { logger } from '../../config/logger.js';
import { query } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import * as commercialDocumentsRepo from '../commercial-documents/commercial-documents.repo.js';

type PaidLine = {
  productName: string;
  description?: string;
  unitPrice: number;
  quantity?: number;
  quantityUnit?: string;
};

type PaidBillingKind = 'AI_CREDITS' | 'AD_SPEND' | 'STORAGE';

type PaidBillingInvoiceInput = {
  workspaceId: string;
  kind: PaidBillingKind;
  referenceId: string;
  currency: string;
  amount: number;
  paidAt?: string | null;
  paymentMethod?: 'CARD' | 'ALIPAY' | 'WECHAT_PAY' | 'BANK_TRANSFER' | 'OTHER';
  paymentReference?: string | null;
  lines: PaidLine[];
  providerInvoiceId?: string | null;
  providerPaymentIntentId?: string | null;
};

type BillingCustomer = { id: string; actorId: string; name: string; email: string | null };

function normalizeAmount(value: number) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function dateOnly(value?: string | null) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function operationKey(input: Pick<PaidBillingInvoiceInput, 'kind' | 'referenceId'>) {
  return `billing-invoice:${input.kind.toLowerCase()}:${input.referenceId}`;
}

function paymentMethod(input: PaidBillingInvoiceInput['paymentMethod']) {
  return input ?? 'OTHER';
}

async function ensureBillingCustomer(workspaceId: string): Promise<BillingCustomer> {
  const existing = await query<BillingCustomer>(
    `SELECT id, created_by AS "actorId", name, data->>'email' AS email
       FROM workspace_records
      WHERE workspace_id=$1 AND resource_type='finance_customers'
        AND external_id=$2 AND deleted_at IS NULL
      LIMIT 1`,
    [workspaceId, `lulu-billing-customer:${workspaceId}`],
  );
  if (existing.rows[0]) return existing.rows[0];

  const workspace = await query<{ name: string; createdBy: string; ownerId: string | null; ownerEmail: string | null; memberId: string | null; memberEmail: string | null }>(
    `SELECT w.name, w.created_by AS "createdBy",
            owner.id AS "ownerId", owner.email AS "ownerEmail"
            ,member.id AS "memberId", member.email AS "memberEmail"
       FROM workspaces w
       LEFT JOIN LATERAL (
         SELECT u.id, u.email
           FROM workspace_members wm
           JOIN users u ON u.id=wm.user_id AND u.deleted_at IS NULL
          WHERE wm.workspace_id=w.id AND wm.role='owner'
          ORDER BY wm.joined_at
          LIMIT 1
       ) owner ON TRUE
      LEFT JOIN LATERAL (
        SELECT u.id, u.email
          FROM workspace_members wm
          JOIN users u ON u.id=wm.user_id AND u.deleted_at IS NULL
         WHERE wm.workspace_id=w.id
         ORDER BY (wm.role='owner') DESC, wm.joined_at
         LIMIT 1
      ) member ON TRUE
      WHERE w.id=$1 AND w.deleted_at IS NULL`,
    [workspaceId],
  );
  const source = workspace.rows[0];
  if (!source) throw new Error(`Workspace ${workspaceId} was not found while creating a billing invoice.`);
  let actorId = source.ownerId ?? source.memberId;
  if (!actorId && source.createdBy) {
    // A legacy/test workspace can predate the owner-membership insert that
    // normally happens during workspace creation. Repair only that invariant
    // case using the recorded creator; the workspace-record trigger then has
    // a valid tenant member to attribute the billing customer to.
    const repaired = await query<{ userId: string }>(
      `INSERT INTO workspace_members(workspace_id, user_id, role)
       VALUES($1,$2,'owner')
       ON CONFLICT (workspace_id,user_id) DO NOTHING
       RETURNING user_id AS "userId"`,
      [workspaceId, source.createdBy],
    );
    actorId = repaired.rows[0]?.userId ?? source.createdBy;
  }
  if (!actorId) throw new Error(`Workspace ${workspaceId} has no active billing actor.`);
  // Keep this billing path safe during startup and maintenance jobs that can
  // run before the global resource-catalog sync has completed.
  await query(
    `INSERT INTO resource_types(key, domain, label, description)
     VALUES('finance_customers','finance','Finance Customers','Billing customer records.')
     ON CONFLICT (key) DO NOTHING`,
  );
  const ownerEmail = source.ownerEmail ?? source.memberEmail;
  const name = ownerEmail ? `${source.name} — ${ownerEmail}` : source.name;
  const data = {
    email: ownerEmail,
    billingRole: 'workspace_payer',
    provider: 'airwallex',
    managedBy: 'lulu-billing',
  };
  let created: { rows: BillingCustomer[] } = { rows: [] };
  try {
    // workspace_records protects external IDs with a partial unique index
    // (deleted records are intentionally excluded), so PostgreSQL cannot use
    // a plain ON CONFLICT target here. A duplicate concurrent insert is safe:
    // the select below returns the winner's canonical customer.
    created = await query<BillingCustomer>(
      `INSERT INTO workspace_records(
         workspace_id, resource_type, name, description, status, external_id,
         source, tags, data, created_by, updated_by
       ) VALUES($1,'finance_customers',$2,$3,'active',$4,'billing',$5,$6::jsonb,$7,$7)
       RETURNING id, created_by AS "actorId", name, data->>'email' AS email`,
      [
        workspaceId,
        name,
        'Automatic billing customer used for prepaid balances and metered storage invoices.',
        `lulu-billing-customer:${workspaceId}`,
        ['billing', 'airwallex', 'automatic'],
        JSON.stringify(data),
        actorId,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
  }
  if (created.rows[0]) return created.rows[0];
  const raced = await query<BillingCustomer>(
    `SELECT id, created_by AS "actorId", name, data->>'email' AS email
       FROM workspace_records
      WHERE workspace_id=$1 AND resource_type='finance_customers'
        AND external_id=$2 AND deleted_at IS NULL
      LIMIT 1`,
    [workspaceId, `lulu-billing-customer:${workspaceId}`],
  );
  if (!raced.rows[0]) throw new Error(`Billing customer for workspace ${workspaceId} could not be created.`);
  return raced.rows[0];
}

/**
 * Creates the canonical Lulu invoice after Airwallex has confirmed cash.
 * The provider invoice is deliberately not treated as Lulu's own document:
 * this creates the customer-facing invoice visible in the Finance workspace.
 */
export async function createPaidBillingInvoice(input: PaidBillingInvoiceInput) {
  const amount = normalizeAmount(input.amount);
  if (amount <= 0 || input.lines.length === 0) return null;
  const key = operationKey(input);
  const platformSellerProfile = await commercialDocumentsRepo.getPlatformBillingSellerProfile();
  const prior = await query<{ documentId: string }>(
    `SELECT document_id AS "documentId"
       FROM commercial_document_operations
      WHERE workspace_id=$1
        AND operation_key=$2
        AND operation_type='invoice.create'
        AND status='COMPLETED'
        AND document_id IS NOT NULL
      LIMIT 1`,
    [input.workspaceId, key],
  );
  try {
    const customer = await ensureBillingCustomer(input.workspaceId);
    let invoice = prior.rows[0]
      ? await commercialDocumentsRepo.setInvoiceSellerProfile(input.workspaceId, prior.rows[0].documentId, platformSellerProfile)
      : await commercialDocumentsRepo.createInvoice(
          input.workspaceId,
          customer.actorId,
          {
            customerRecordId: customer.id,
            currency: input.currency.toUpperCase(),
            language: 'en',
            invoiceType: 'STANDARD',
            issueDate: dateOnly(input.paidAt),
            dueDate: dateOnly(input.paidAt),
            source: 'api',
            creationMode: 'AUTOMATIC',
            operationKey: key,
            lines: input.lines.map((line) => ({
              productName: line.productName,
              description: line.description ?? null,
              quantity: line.quantity ?? 1,
              quantityUnit: line.quantityUnit ?? 'item',
              unitPrice: normalizeAmount(line.unitPrice),
              discount: 0,
              tax: 0,
            })),
            shippingTotal: 0,
          },
          {
            actorType: 'SYSTEM',
            actorRef: input.providerInvoiceId ?? input.providerPaymentIntentId ?? input.referenceId,
          },
        );
    if (!invoice) throw new Error('Automatic billing invoice creation returned no invoice.');

    let current = invoice;
    if (current.invoice.status === 'DRAFT' || current.invoice.status === 'READY') {
      try {
        const issued = await commercialDocumentsRepo.issueInvoice(input.workspaceId, current.invoice.id, customer.actorId, platformSellerProfile);
        if (!issued) {
          logger.warn({ workspaceId: input.workspaceId, invoiceId: current.invoice.id, referenceId: input.referenceId }, 'Automatic billing invoice could not be loaded after issuing');
          return current;
        }
        current = issued;
      } catch (error) {
        logger.warn({ error, workspaceId: input.workspaceId, invoiceId: current.invoice.id, referenceId: input.referenceId }, 'Automatic billing invoice was saved but could not be issued yet');
        return current;
      }
    }
    // Automatic prepaid invoices must expose the same canonical PDF link as
    // manually issued invoices.  This also repairs older invoices that were
    // already paid before document-link generation was added.
    await commercialDocumentsRepo.ensureInvoiceDocument(input.workspaceId, current.invoice.id, customer.actorId);
    const due = normalizeAmount(Number(current.invoice.amountDue ?? amount));
    if (due > 0 && !['PAID', 'PARTIALLY_PAID'].includes(current.invoice.status)) {
      const payment = await commercialDocumentsRepo.recordInvoicePayment(input.workspaceId, current.invoice.id, customer.actorId, {
        amount: due.toFixed(2),
        paymentMethod: paymentMethod(input.paymentMethod),
        paymentReference: input.paymentReference ?? input.providerInvoiceId ?? input.providerPaymentIntentId ?? input.referenceId,
        receivedAt: input.paidAt ?? new Date().toISOString(),
        idempotencyKey: `${key}:payment`,
        metadata: {
          provider: 'airwallex',
          billingKind: input.kind,
          referenceId: input.referenceId,
          providerInvoiceId: input.providerInvoiceId ?? null,
          providerPaymentIntentId: input.providerPaymentIntentId ?? null,
        },
      });
      await commercialDocumentsRepo.ensureInvoiceDocument(input.workspaceId, current.invoice.id, customer.actorId);
      return (await commercialDocumentsRepo.getInvoice(input.workspaceId, current.invoice.id)) ?? payment.invoice;
    }
    return (await commercialDocumentsRepo.getInvoice(input.workspaceId, current.invoice.id)) ?? current;
  } catch (error) {
    logger.error({ error, workspaceId: input.workspaceId, kind: input.kind, referenceId: input.referenceId }, 'Automatic paid billing invoice creation failed; reconciliation will retry it');
    // Do not rely only on the periodic billing sweep. A provider webhook may
    // be marked handled even when invoice persistence is temporarily blocked
    // by a transient database/provider dependency. Enqueue a durable billing
    // cycle request so the same idempotent reconciliation path retries soon.
    try {
      const retryBucket = Math.floor(Date.now() / 60_000);
      await appendDomainEvent({
        type: DOMAIN_EVENT_TYPES.BILLING_CYCLE_REQUESTED,
        aggregateType: 'billing_reconciliation',
        aggregateId: input.referenceId,
        payload: { workspaceId: input.workspaceId, kind: input.kind, referenceId: input.referenceId },
        metadata: { source: 'paid-billing-invoice.service', reason: 'invoice_persistence_failed' },
        idempotencyKey: `billing-reconcile:${input.kind.toLowerCase()}:${input.referenceId}:${retryBucket}`,
      });
    } catch (retryError) {
      logger.warn({ retryError, workspaceId: input.workspaceId, kind: input.kind, referenceId: input.referenceId }, 'Paid billing invoice retry event could not be queued');
    }
    return null;
  }
}

/**
 * Repair seller snapshots on automatic billing invoices already in the
 * database. This is deliberately separate from payment reconciliation so it
 * also covers invoices that were paid successfully before the seller-role fix.
 */
export async function reconcileAutomaticBillingInvoiceSellers(limit = 500) {
  const bounded = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  const sellerProfile = await commercialDocumentsRepo.getPlatformBillingSellerProfile();
  const candidates = await query<{ workspaceId: string; id: string }>(
    `SELECT i.workspace_id AS "workspaceId", i.id
       FROM invoices i
      WHERE i.source='api'
        AND i.creation_mode='AUTOMATIC'
        AND i.status NOT IN ('CANCELLED','VOID')
        AND i.metadata->'sellerProfile' IS DISTINCT FROM $2::jsonb
      ORDER BY i.created_at ASC
      LIMIT $1`,
    [bounded, JSON.stringify(sellerProfile)],
  );
  let repaired = 0;
  let failed = 0;
  for (const invoice of candidates.rows) {
    try {
      const result = await commercialDocumentsRepo.setInvoiceSellerProfile(invoice.workspaceId, invoice.id, sellerProfile);
      if (result) repaired += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ error, workspaceId: invoice.workspaceId, invoiceId: invoice.id }, 'Automatic billing invoice seller repair failed');
    }
  }
  return { checked: candidates.rows.length, repaired, failed };
}

function topupPaymentMethod(value: string | null | undefined): NonNullable<PaidBillingInvoiceInput['paymentMethod']> {
  if (value === 'card') return 'CARD';
  if (value === 'alipaycn') return 'ALIPAY';
  if (value === 'wechatpay') return 'WECHAT_PAY';
  return 'OTHER';
}

export async function createPaidAiCreditInvoice(input: {
  topupId: string;
  workspaceId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  paidAt?: string | null;
  providerInvoiceId?: string | null;
  providerPaymentIntentId?: string | null;
}) {
  return createPaidBillingInvoice({
    workspaceId: input.workspaceId,
    kind: 'AI_CREDITS',
    referenceId: input.topupId,
    currency: input.currency,
    amount: input.amount,
    paidAt: input.paidAt ?? null,
    paymentMethod: topupPaymentMethod(input.paymentMethod),
    paymentReference: input.providerInvoiceId ?? input.providerPaymentIntentId ?? null,
    providerInvoiceId: input.providerInvoiceId ?? null,
    providerPaymentIntentId: input.providerPaymentIntentId ?? null,
    lines: [{ productName: 'Prepaid AI execution credits', description: 'AI and premium-media execution balance', unitPrice: input.amount }],
  });
}

export async function createPaidAdSpendInvoice(input: {
  topupId: string;
  workspaceId: string;
  amount: number;
  feeAmount: number;
  totalAmount: number;
  currency: string;
  paymentMethod: string;
  paidAt?: string | null;
  providerInvoiceId?: string | null;
  providerPaymentIntentId?: string | null;
}) {
  return createPaidBillingInvoice({
    workspaceId: input.workspaceId,
    kind: 'AD_SPEND',
    referenceId: input.topupId,
    currency: input.currency,
    amount: input.totalAmount,
    paidAt: input.paidAt ?? null,
    paymentMethod: topupPaymentMethod(input.paymentMethod),
    paymentReference: input.providerInvoiceId ?? input.providerPaymentIntentId ?? null,
    providerInvoiceId: input.providerInvoiceId ?? null,
    providerPaymentIntentId: input.providerPaymentIntentId ?? null,
    lines: [
      { productName: 'Prepaid advertising budget', description: 'Funds credited to the autonomous advertising wallet', unitPrice: input.amount },
      { productName: 'Lulu advertising service fee', description: '4% service fee charged on top of the advertising budget', unitPrice: input.feeAmount },
    ],
  });
}

export async function createPaidStorageInvoice(input: {
  periodId: string;
  workspaceId: string;
  amount: number;
  currency: string;
  paidAt?: string | null;
  providerInvoiceId?: string | null;
}) {
  return createPaidBillingInvoice({
    workspaceId: input.workspaceId,
    kind: 'STORAGE',
    referenceId: input.periodId,
    currency: input.currency,
    amount: input.amount,
    paidAt: input.paidAt ?? null,
    paymentMethod: 'CARD',
    paymentReference: input.providerInvoiceId ?? null,
    providerInvoiceId: input.providerInvoiceId ?? null,
    lines: [{ productName: 'Cloudflare R2 storage and operations', description: 'Metered storage, Class A/B operations and bandwidth for the paid usage period', unitPrice: input.amount }],
  });
}

export async function reconcilePaidBillingInvoices(limit = 50) {
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
  const sellerRepair = await reconcileAutomaticBillingInvoiceSellers();
  const candidates = await query<{ kind: PaidBillingKind; referenceId: string; workspaceId: string; occurredAt: string }>(
    `SELECT 'AI_CREDITS'::text AS kind, t.id::text AS "referenceId", t.workspace_id AS "workspaceId",
            COALESCE(t.paid_at,t.credited_at,t.created_at) AS "occurredAt"
       FROM workspace_api_topups t
      -- Older Airwallex webhook/import paths used PAID, COMPLETED or
      -- CONFIRMED in one of the status columns. A credited wallet is the
      -- non-negotiable proof that the customer balance was actually funded;
      -- accept all provider-success aliases so historical paid top-ups are
      -- not stranded without a Lulu invoice.
      WHERE t.credited_at IS NOT NULL
        AND (UPPER(COALESCE(t.status,'')) IN ('SUCCEEDED','PAID','COMPLETED','CONFIRMED')
          OR UPPER(COALESCE(t.payment_status,'')) IN ('SUCCEEDED','PAID','COMPLETED','CONFIRMED'))
        AND NOT EXISTS (
          SELECT 1
            FROM commercial_document_operations o
            JOIN invoices i ON i.workspace_id=o.workspace_id AND i.id=o.document_id
           WHERE o.workspace_id=t.workspace_id
             AND o.operation_key='billing-invoice:ai_credits:' || t.id::text
             AND o.operation_type='invoice.create'
             AND o.status='COMPLETED'
             AND i.status='PAID'
             AND i.document_status='READY'
             AND i.document_storage_reference IS NOT NULL
        )
     UNION ALL
     SELECT 'AD_SPEND'::text, t.id::text, t.workspace_id,
            COALESCE(t.paid_at,t.credited_at,t.created_at)
       FROM workspace_ad_spend_topups t
      WHERE t.credited_at IS NOT NULL
        AND (UPPER(COALESCE(t.status,'')) IN ('SUCCEEDED','PAID','COMPLETED','CONFIRMED')
          OR UPPER(COALESCE(t.payment_status,'')) IN ('SUCCEEDED','PAID','COMPLETED','CONFIRMED'))
        AND NOT EXISTS (
          SELECT 1
            FROM commercial_document_operations o
            JOIN invoices i ON i.workspace_id=o.workspace_id AND i.id=o.document_id
           WHERE o.workspace_id=t.workspace_id
             AND o.operation_key='billing-invoice:ad_spend:' || t.id::text
             AND o.operation_type='invoice.create'
             AND o.status='COMPLETED'
             AND i.status='PAID'
             AND i.document_status='READY'
             AND i.document_storage_reference IS NOT NULL
        )
     UNION ALL
     SELECT 'STORAGE'::text, p.id::text, p.workspace_id,
            COALESCE(p.paid_at,p.finalized_at,p.created_at)
       FROM workspace_payg_periods p
      WHERE UPPER(COALESCE(p.status,'')) IN ('PAID','SUCCEEDED','COMPLETED','CONFIRMED')
        AND p.server_cost_usd > 0
        AND NOT EXISTS (
          SELECT 1
            FROM commercial_document_operations o
            JOIN invoices i ON i.workspace_id=o.workspace_id AND i.id=o.document_id
           WHERE o.workspace_id=p.workspace_id
             AND o.operation_key='billing-invoice:storage:' || p.id::text
             AND o.operation_type='invoice.create'
             AND o.status='COMPLETED'
             AND i.status='PAID'
             AND i.document_status='READY'
             AND i.document_storage_reference IS NOT NULL
        )
      ORDER BY "occurredAt" ASC NULLS LAST, "referenceId"
      LIMIT $1`,
    [bounded],
  );
  let created = 0;
  let repaired = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      const existing = await query<{ documentStatus: string; documentStorageReference: string | null }>(
        `SELECT i.document_status AS "documentStatus",i.document_storage_reference AS "documentStorageReference"
           FROM commercial_document_operations o
           JOIN invoices i ON i.workspace_id=o.workspace_id AND i.id=o.document_id
          WHERE o.workspace_id=$1 AND o.operation_key=$2 AND o.operation_type='invoice.create'
            AND o.status='COMPLETED'
          LIMIT 1`,
        [candidate.workspaceId, operationKey({ kind: candidate.kind, referenceId: candidate.referenceId })],
      );
      const needsDocumentRepair = Boolean(existing.rows[0])
        && (existing.rows[0]!.documentStatus !== 'READY' || !existing.rows[0]!.documentStorageReference);
      const result = candidate.kind === 'AI_CREDITS'
        ? await query<any>(`SELECT id::text AS id,workspace_id AS "workspaceId",amount::numeric AS amount,currency,payment_method AS "paymentMethod",paid_at AS "paidAt",provider_invoice_id AS "providerInvoiceId",provider_payment_intent_id AS "providerPaymentIntentId" FROM workspace_api_topups WHERE id=$1`, [candidate.referenceId])
        : candidate.kind === 'AD_SPEND'
          ? await query<any>(`SELECT id::text AS id,workspace_id AS "workspaceId",net_amount::numeric AS amount,fee_amount::numeric AS "feeAmount",total_amount::numeric AS "totalAmount",currency,payment_method AS "paymentMethod",paid_at AS "paidAt",provider_invoice_id AS "providerInvoiceId",provider_payment_intent_id AS "providerPaymentIntentId" FROM workspace_ad_spend_topups WHERE id=$1`, [candidate.referenceId])
          : await query<any>(`SELECT id::text AS id,workspace_id AS "workspaceId",server_cost_usd::numeric AS amount,currency,paid_at AS "paidAt",provider_invoice_id AS "providerInvoiceId" FROM workspace_payg_periods WHERE id=$1`, [candidate.referenceId]);
      const row = result.rows[0];
      if (!row) continue;
      const invoice = candidate.kind === 'AI_CREDITS'
        ? await createPaidAiCreditInvoice({ ...row, topupId: row.id })
        : candidate.kind === 'AD_SPEND'
          ? await createPaidAdSpendInvoice({ ...row, topupId: row.id })
          : await createPaidStorageInvoice({ ...row, periodId: row.id });
      if (invoice) {
        if (needsDocumentRepair) repaired += 1;
        else created += 1;
      }
    } catch (error) {
      failed += 1;
      logger.warn({ error, kind: candidate.kind, referenceId: candidate.referenceId }, 'Paid billing invoice reconciliation candidate failed');
    }
  }
  return { checked: candidates.rows.length, created, repaired, failed, sellerRepair };
}
