import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { createOrder, transitionOrder } from '../commerce/commerce.service.js';
import * as recordService from '../records/record.service.js';
import type { StorefrontCart, StorefrontCartItem, StorefrontProduct, StorefrontSite } from './storefront.types.js';
import type { StorefrontRequestDetails } from './storefront.validator.js';

const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
const slugify = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'product';

function productFromRow(row: any): StorefrontProduct {
  return {
    id: row.id,
    slug: row.slug || slugify(row.name),
    name: row.name,
    shortDescription: row.shortDescription ?? null,
    longDescription: row.longDescription ?? null,
    currency: row.currency ?? null,
    price: row.price ?? null,
    imageUrl: row.imageUrl ?? null,
    imageAlt: row.imageAlt ?? null,
    category: row.category ?? null,
  };
}

const productSelect = `
  p.id, p.name, p.short_description AS "shortDescription", p.long_description AS "longDescription",
  p.default_currency AS currency, p.default_price AS price,
  COALESCE(seo.slug, lower(regexp_replace(regexp_replace(p.name, '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))) AS slug,
  media.external_url AS "imageUrl", media.alt_text AS "imageAlt", category.name AS category
  FROM products p
  LEFT JOIN LATERAL (
    SELECT s.slug FROM product_seo_metadata s
    WHERE s.workspace_id=p.workspace_id AND s.product_id=p.id AND s.status IN ('ACTIVE','DRAFT')
    ORDER BY CASE WHEN s.language='en' THEN 0 ELSE 1 END, s.updated_at DESC LIMIT 1
  ) seo ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.external_url, m.alt_text FROM product_media m
    WHERE m.workspace_id=p.workspace_id AND m.product_id=p.id AND m.media_type='IMAGE' AND m.external_url IS NOT NULL
    ORDER BY m.is_primary DESC, m.sort_order, m.created_at LIMIT 1
  ) media ON TRUE
  LEFT JOIN product_categories category ON category.workspace_id=p.workspace_id AND category.id=p.category_id
`;
const productProjection = productSelect.slice(0, productSelect.indexOf('FROM products p'));
const productJoins = productSelect.slice(productSelect.indexOf('FROM products p') + 'FROM products p'.length);

type PublicSiteLookupOptions = {
  /**
   * A verified custom domain may be connected before the first publication.
   * The host renderer needs to serve the neutral template in that state, while
   * slug-based public APIs must continue to expose published sites only.
   */
  allowUnpublished?: boolean;
};

async function siteBySlug(slug: string, options: PublicSiteLookupOptions = {}) {
  const statusPredicate = options.allowUnpublished ? "s.status <> 'disconnected'" : "s.status='published'";
  const result = await query<any>(`
    SELECT s.id, s.workspace_id AS "workspaceId", s.name, s.status, s.settings,
      COALESCE(NULLIF(s.settings->'managedWebsite'->>'publicSlug',''), s.id::text) AS slug,
      COALESCE(NULLIF(s.settings->'managedWebsite'->>'templateKey',''), 'lulu-standard-v1') AS "templateKey",
      COALESCE(s.external_site_url, '') AS "externalSiteUrl"
    FROM workspace_sites s
    WHERE s.provider='managed' AND ${statusPredicate}
      AND (s.id::text=$1 OR lower(s.settings->'managedWebsite'->>'publicSlug')=lower($1))
    LIMIT 1`, [slug]);
  return result.rows[0] ?? null;
}

async function siteByHostname(hostname: string, options: PublicSiteLookupOptions = {}) {
  const statusPredicate = options.allowUnpublished ? "s.status <> 'disconnected'" : "s.status='published'";
  const result = await query<any>(`
    SELECT s.id, s.workspace_id AS "workspaceId", s.name, s.status, s.settings,
      COALESCE(NULLIF(s.settings->'managedWebsite'->>'publicSlug',''), s.id::text) AS slug,
      COALESCE(NULLIF(s.settings->'managedWebsite'->>'templateKey',''), 'lulu-standard-v1') AS "templateKey",
      COALESCE(s.external_site_url, '') AS "externalSiteUrl"
    FROM workspace_site_domains d
    JOIN workspace_sites s ON s.id=d.site_id
    WHERE s.provider='managed' AND ${statusPredicate}
      AND d.status='verified' AND lower(d.hostname)=lower($1)
    LIMIT 1`, [hostname]);
  return result.rows[0] ?? null;
}

export async function getPublicStorefront(slug: string, options: PublicSiteLookupOptions = {}): Promise<StorefrontSite | null> {
  const site = await siteBySlug(slug, options);
  if (!site) return null;
  const [products, domains] = await Promise.all([
    query<any>(`SELECT ${productSelect} WHERE p.workspace_id=$1 AND p.status='ACTIVE' AND p.visibility='PUBLIC' AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`, [site.workspaceId]),
    query<{ hostname: string; status: string }>(`SELECT hostname,status FROM workspace_site_domains WHERE site_id=$1 AND status <> 'removed' ORDER BY created_at`, [site.id]),
  ]);
  const assets = await query<{ id: string; altText: string; placement: string }>(`SELECT id,alt_text AS "altText",placement FROM managed_website_assets WHERE site_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`, [site.id]);
  const managedWebsite = site.settings?.managedWebsite && typeof site.settings.managedWebsite === 'object' ? site.settings.managedWebsite : {};
  const plan = managedWebsite.plan && typeof managedWebsite.plan === 'object' ? managedWebsite.plan : {};
  return {
    id: site.id,
    workspaceId: site.workspaceId,
    name: site.name,
    slug: site.slug,
    status: site.status,
    templateKey: site.templateKey,
    previewUrl: String(managedWebsite.previewUrl ?? `/api/v1/public/storefront/${encodeURIComponent(site.slug)}`),
    customDomains: domains.rows,
    plan,
    products: products.rows.map(productFromRow),
    assets: assets.rows.map((asset) => ({ id: asset.id, publicUrl: `/api/v1/public/storefront/assets/${encodeURIComponent(asset.id)}`, altText: asset.altText ?? '', placement: asset.placement })),
  };
}

/**
 * Resolve a managed storefront from a verified HTTP Host header.
 *
 * Domain ownership is the authorization boundary here. Once DNS verification
 * succeeds, the domain can serve Lulu's neutral template immediately, even
 * while the site record is still in draft/generating/preview state. A later
 * publication updates the same site record, so the domain automatically serves
 * the new version without reconnecting DNS.
 */
export async function getPublicStorefrontByHostname(hostname: string): Promise<StorefrontSite | null> {
  const site = await siteByHostname(hostname, { allowUnpublished: true });
  if (!site) return null;
  return getPublicStorefront(site.slug, { allowUnpublished: true });
}

export async function listPublicProducts(slug: string) {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const rows = await query<any>(`SELECT ${productSelect} WHERE p.workspace_id=$1 AND p.status='ACTIVE' AND p.visibility='PUBLIC' AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`, [site.workspaceId]);
  return rows.rows.map(productFromRow);
}

export async function getPublicProduct(slug: string, productSlug: string) {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const result = await query<any>(`SELECT ${productSelect} WHERE p.workspace_id=$1 AND p.status='ACTIVE' AND p.visibility='PUBLIC' AND p.deleted_at IS NULL AND (p.id::text=$2 OR lower(COALESCE(seo.slug, ''))=lower($2) OR lower(regexp_replace(regexp_replace(p.name, '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))=lower($2)) LIMIT 1`, [site.workspaceId, productSlug]);
  return result.rows[0] ? productFromRow(result.rows[0]) : null;
}

export async function createCart(slug: string, currency: string) {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const token = randomBytes(32).toString('base64url');
  const result = await query<{ id: string; expiresAt: string }>(`INSERT INTO storefront_carts(site_id,workspace_id,token_hash,currency) VALUES($1,$2,$3,$4) RETURNING id,expires_at AS "expiresAt"`, [site.id, site.workspaceId, hashToken(token), currency]);
  const row = result.rows[0];
  if (!row) throw new Error('Storefront cart insert did not return a row');
  return { token, id: row.id, expiresAt: row.expiresAt, currency };
}

async function cartRow(siteId: string, token: string) {
  const result = await query<any>(`SELECT id,site_id AS "siteId",workspace_id AS "workspaceId",token_hash AS "tokenHash",currency,status,expires_at AS "expiresAt" FROM storefront_carts WHERE site_id=$1 AND token_hash=$2 AND status IN ('OPEN','CHECKOUT') AND expires_at>NOW() LIMIT 1`, [siteId, hashToken(token)]);
  return result.rows[0] ?? null;
}

async function ensureStorefrontContact(workspaceId: string, email: string) {
  const normalized = email.trim().toLowerCase();
  const existing = await query<{ id: string }>(
    `SELECT id FROM workspace_records
      WHERE workspace_id=$1 AND resource_type='crm_contacts' AND deleted_at IS NULL
        AND lower(COALESCE(data->>'email', data->>'emailAddress', ''))=$2
      ORDER BY created_at ASC LIMIT 1`,
    [workspaceId, normalized],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const owner = await query<{ userId: string }>(
    `SELECT user_id AS "userId" FROM workspace_members
      WHERE workspace_id=$1 AND role IN ('owner','admin')
      ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END, joined_at ASC LIMIT 1`,
    [workspaceId],
  );
  if (!owner.rows[0]) return null;
  const localPart = normalized.split('@')[0]?.replace(/[._-]+/g, ' ').trim() || normalized;
  const contact = await recordService.createRecord(workspaceId, 'crm_contacts', owner.rows[0].userId, {
    name: localPart.slice(0, 300),
    status: 'Active',
    source: 'lulu-storefront',
    data: { email: normalized, source: 'lulu-storefront', firstSeenAt: new Date().toISOString() },
  });
  return contact.id;
}

function requestDetailsForPersistence(details: StorefrontRequestDetails) {
  const { attachment, ...rest } = details;
  return {
    ...rest,
    ...(attachment ? { attachment: { fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes } } : {}),
  };
}

async function persistContactRequest(site: { id: string; workspaceId: string }, email: string, details: StorefrontRequestDetails, checkoutSessionId: string | null) {
  const attachment = details.attachment;
  const content = attachment ? Buffer.from(attachment.dataBase64, 'base64') : null;
  if (attachment && (!content || content.length !== attachment.sizeBytes)) throw new Error('The uploaded file is invalid or incomplete');
  const result = await query<{ id: string }>(
    `INSERT INTO storefront_contact_requests(site_id,workspace_id,checkout_session_id,customer_email,website_url,whatsapp_number,note,attachment_file_name,attachment_mime_type,attachment_size_bytes,attachment_content)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [site.id, site.workspaceId, checkoutSessionId, email, details.websiteUrl ?? null, details.whatsappNumber ?? null, details.note ?? '', attachment?.fileName ?? null, attachment?.mimeType ?? null, attachment?.sizeBytes ?? null, content],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Storefront contact request insert did not return a row');
  return row.id;
}

export async function getCart(slug: string, token: string): Promise<StorefrontCart | null> {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const cart = await cartRow(site.id, token);
  if (!cart) return null;
  const items = await query<any>(`SELECT ci.variant_id AS "variantId", ci.quantity::text AS quantity, ci.unit_price::text AS "unitPrice", (ci.quantity*ci.unit_price)::text AS "lineTotal", ${productProjection} FROM storefront_cart_items ci JOIN products p ON p.id=ci.product_id AND p.workspace_id=$2 ${productJoins} WHERE ci.cart_id=$1 ORDER BY ci.created_at`, [cart.id, site.workspaceId]);
  const mappedItems = items.rows.map((row: any) => ({ ...productFromRow(row), variantId: row.variantId ?? null, quantity: row.quantity, unitPrice: row.unitPrice, lineTotal: row.lineTotal })) as StorefrontCartItem[];
  const subtotal = mappedItems.reduce((sum, item) => sum + Number(item.lineTotal), 0).toFixed(4);
  return { id: cart.id, token, currency: cart.currency, status: cart.status, items: mappedItems, subtotal, expiresAt: cart.expiresAt };
}

export async function addCartItem(slug: string, token: string, productId: string, variantId: string | null, quantity: string) {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const cart = await cartRow(site.id, token);
  if (!cart) return undefined;
  const result = await withTransaction(async (client) => {
    const product = await query<any>(`SELECT p.id,p.default_price AS price,p.default_currency AS currency FROM products p WHERE p.workspace_id=$1 AND p.id=$2 AND p.status='ACTIVE' AND p.visibility='PUBLIC' AND p.deleted_at IS NULL LIMIT 1`, [site.workspaceId, productId], client);
    if (!product.rows[0]) return null;
    const price = product.rows[0].price;
    if (price === null || price === undefined) return { requiresQuote: true };
    // PostgreSQL treats NULL values as distinct in a normal UNIQUE constraint.
    // Resolve the nullable variant explicitly so repeated base-product adds
    // merge into one line instead of creating duplicate cart rows.
    const existing = await query<{ id: string }>(`SELECT id FROM storefront_cart_items WHERE cart_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid LIMIT 1 FOR UPDATE`, [cart.id, productId, variantId], client);
    if (existing.rows[0]) {
      await query(`UPDATE storefront_cart_items SET quantity=quantity+$2,updated_at=NOW() WHERE id=$1`, [existing.rows[0].id, quantity], client);
    } else {
      await query(`INSERT INTO storefront_cart_items(cart_id,workspace_id,product_id,variant_id,quantity,unit_price,currency) VALUES($1,$2,$3,$4,$5,$6,$7)`, [cart.id, site.workspaceId, productId, variantId, quantity, price, product.rows[0].currency ?? cart.currency], client);
    }
    return { requiresQuote: false };
  });
  if (!result) return null;
  return { ...result, cart: await getCart(slug, token) };
}

export async function createCheckout(slug: string, token: string, email: string, shippingAddress: Record<string, unknown>) {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const cart = await getCart(slug, token);
  if (!cart) return undefined;
  if (!cart.items.length) return { empty: true };
  const existing = await query<{
    id: string;
    orderId: string | null;
    status: string;
    amount: string;
    currency: string;
    paymentProvider: string | null;
    providerSessionId: string | null;
    paymentUrl: string | null;
    providerPaymentIntentId: string | null;
  }>(`SELECT id,order_id AS "orderId",status,amount::text,currency,
      payment_provider AS "paymentProvider",provider_session_id AS "providerSessionId",
      payment_url AS "paymentUrl",provider_payment_intent_id AS "providerPaymentIntentId"
      FROM storefront_checkout_sessions
      WHERE cart_id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_PAYMENT','PAID')
      ORDER BY created_at DESC LIMIT 1`, [cart.id]);
  if (existing.rows[0]) {
    const previous = existing.rows[0];
    return {
      id: previous.id,
      orderId: previous.orderId,
      status: previous.status,
      amount: previous.amount,
      currency: previous.currency,
      paymentProvider: previous.paymentProvider,
      paymentRequired: previous.status === 'PENDING_PAYMENT',
      paymentUrl: previous.paymentUrl,
      providerSessionId: previous.providerSessionId,
      providerPaymentIntentId: previous.providerPaymentIntentId,
      requestType: previous.status === 'PENDING_CONFIRMATION' ? 'order_request' : 'payment_order',
      message: previous.status === 'PAID'
        ? 'Payment received. The company will process your order.'
        : previous.status === 'PENDING_PAYMENT'
          ? 'Your secure payment link is ready.'
          : 'Anfrage bereits erhalten. Das Unternehmen meldet sich zur Bestätigung.',
    };
  }
  const requestDetails = shippingAddress as StorefrontRequestDetails;
  const persistedDetails = requestDetailsForPersistence(requestDetails);
  const result = await query<{ id: string }>(`INSERT INTO storefront_checkout_sessions(site_id,workspace_id,cart_id,customer_email,currency,amount,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`, [site.id, site.workspaceId, cart.id, email, cart.currency, cart.subtotal, JSON.stringify({ shippingAddress: persistedDetails, paymentStatus: 'NOT_APPLICABLE', requestType: 'order_request' })]);
  await query(`UPDATE storefront_carts SET status='CHECKOUT',updated_at=NOW() WHERE id=$1`, [cart.id]);
  const row = result.rows[0];
  if (!row) throw new Error('Storefront checkout insert did not return a row');
  try {
    await persistContactRequest(site, email, requestDetails, row.id);
    const customerRecordId = await ensureStorefrontContact(site.workspaceId, email).catch(() => null);
    const order = await createOrder(site.workspaceId, { actorType: 'SYSTEM', actorRef: `storefront:${site.id}` }, {
      idempotencyKey: `storefront-request:${row.id}`,
      currency: cart.currency,
      shippingTotal: '0',
      customerRecordId,
      source: 'api',
      sourceProvider: 'lulu-storefront',
      externalReference: row.id,
      notes: `Storefront order request from ${email}`,
      shippingAddress: persistedDetails,
      billingAddress: {},
      metadata: { storefrontSiteId: site.id, storefrontCheckoutId: row.id, customerEmail: email, requestType: 'order_request' },
      lines: cart.items.map((item) => ({ productId: item.id, variantId: item.variantId, inventoryLocationId: null, quantity: item.quantity, quantityUnit: 'unit', unitPrice: item.unitPrice, discount: '0', tax: '0', metadata: { storefront: true } })),
    });
    const orderId = order.order.id;
    await query(`UPDATE storefront_checkout_sessions SET status='PENDING_PAYMENT',order_id=$2,metadata=metadata||$3::jsonb,updated_at=NOW() WHERE id=$1`, [row.id, orderId, JSON.stringify({ orderId, requestType: 'payment_order', paymentStatus: 'PENDING' })]);
    return {
      id: row.id,
      orderId,
      status: 'PENDING_PAYMENT',
      amount: cart.subtotal,
      currency: cart.currency,
      paymentProvider: 'airwallex',
      paymentRequired: true,
      paymentUrl: null,
      providerSessionId: null,
      providerPaymentIntentId: null,
      requestType: 'payment_order',
      message: 'Your secure payment link is being prepared.',
    };
  } catch (error) {
    await query(`UPDATE storefront_checkout_sessions SET status='FAILED',metadata=metadata||$2::jsonb,updated_at=NOW() WHERE id=$1`, [row.id, JSON.stringify({ orderCreationFailed: true })]).catch(() => undefined);
    throw error;
  }
}

export async function attachPaymentLink(input: {
  checkoutId: string;
  provider: string;
  providerSessionId: string;
  paymentUrl: string;
  providerStatus?: string | null;
}) {
  const result = await query<{
    id: string;
    orderId: string | null;
    status: string;
    amount: string;
    currency: string;
    paymentProvider: string | null;
    providerSessionId: string | null;
    paymentUrl: string | null;
    providerPaymentIntentId: string | null;
  }>(`UPDATE storefront_checkout_sessions
      SET payment_provider=$2,provider_session_id=$3,payment_url=$4,
          provider_status=$5,metadata=metadata||$6::jsonb,updated_at=NOW()
      WHERE id=$1 AND status='PENDING_PAYMENT'
      RETURNING id,order_id AS "orderId",status,amount::text,currency,
        payment_provider AS "paymentProvider",provider_session_id AS "providerSessionId",
        payment_url AS "paymentUrl",provider_payment_intent_id AS "providerPaymentIntentId"`, [
    input.checkoutId,
    input.provider,
    input.providerSessionId,
    input.paymentUrl,
    input.providerStatus ?? 'UNPAID',
    JSON.stringify({ paymentStatus: 'PENDING', paymentLinkCreatedAt: new Date().toISOString() }),
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    paymentProvider: row.paymentProvider,
    paymentRequired: true,
    paymentUrl: row.paymentUrl,
    providerSessionId: row.providerSessionId,
    providerPaymentIntentId: row.providerPaymentIntentId,
    requestType: 'payment_order' as const,
    message: 'Your secure payment link is ready.',
  };
}

export async function markCheckoutPaymentFailed(checkoutId: string, failureCode: string) {
  await query(
    `UPDATE storefront_checkout_sessions
        SET status='FAILED',failure_code=$2,provider_status='FAILED',
            metadata=metadata||$3::jsonb,updated_at=NOW()
      WHERE id=$1 AND status='PENDING_PAYMENT'`,
    [checkoutId, failureCode.slice(0, 120), JSON.stringify({ paymentStatus: 'FAILED' })],
  );
}

export async function applyStorefrontPaymentWebhook(input: {
  checkoutId: string;
  providerPaymentLinkId?: string | null;
  providerPaymentIntentId?: string | null;
  providerStatus: string;
  providerPayload: Record<string, unknown>;
  paidAt?: string | null;
}) {
  const updated = await withTransaction(async (client) => {
    const locked = await query<{ id: string; workspaceId: string; orderId: string | null; status: string }>(
      `SELECT id,workspace_id AS "workspaceId",order_id AS "orderId",status
         FROM storefront_checkout_sessions WHERE id=$1 FOR UPDATE`,
      [input.checkoutId],
      client,
    );
    const session = locked.rows[0];
    if (!session) return null;
    if (session.status === 'PAID') return { ...session, alreadyPaid: true };
    if (session.status !== 'PENDING_PAYMENT') return { ...session, alreadyPaid: false };
    const changed = await query<{ id: string }>(
      `UPDATE storefront_checkout_sessions
          SET status='PAID',provider_status=$2,
              provider_payment_intent_id=COALESCE($3,provider_payment_intent_id),
              paid_at=COALESCE($4::timestamptz,NOW()),
              metadata=metadata||$5::jsonb,updated_at=NOW()
        WHERE id=$1 AND status='PENDING_PAYMENT' RETURNING id`,
      [
        input.checkoutId,
        input.providerStatus.slice(0, 80),
        input.providerPaymentIntentId ?? null,
        input.paidAt ?? null,
        JSON.stringify({ paymentStatus: 'PAID', providerPayload: input.providerPayload }),
      ],
      client,
    );
    return changed.rows[0] ? { ...session, status: 'PAID', alreadyPaid: false } : { ...session, alreadyPaid: true };
  });
  if (!updated || !updated.orderId || updated.alreadyPaid) return updated;
  const order = await query<{ status: string; version: number }>(
    `SELECT status,version FROM commerce_orders WHERE workspace_id=$1 AND id=$2`,
    [updated.workspaceId, updated.orderId],
  );
  const current = order.rows[0];
  if (current?.status === 'DRAFT') {
    await transitionOrder(updated.workspaceId, updated.orderId, { actorType: 'SYSTEM', actorRef: `storefront-payment:${updated.id}` }, {
      idempotencyKey: `storefront-payment-placed:${updated.id}`,
      expectedVersion: current.version,
      targetStatus: 'PLACED',
      reason: 'Hosted storefront payment verified by Airwallex webhook',
    });
  }
  return updated;
}

export async function applyStorefrontPaymentAdjustment(input: {
  checkoutId?: string | null;
  providerPaymentLinkId?: string | null;
  providerPaymentIntentId?: string | null;
  provider: string;
  providerAdjustmentId: string;
  sourceEventId: string;
  kind: 'REFUND' | 'DISPUTE';
  status: 'PENDING' | 'ACTIVE' | 'RELEASED' | 'FAILED';
  amount: string;
  currency: string;
  providerStatus: string;
  providerPayload: Record<string, unknown>;
  occurredAt?: string | null;
}) {
  return withTransaction(async (client) => {
    const session = await query<{
      id: string;
      workspaceId: string;
      orderId: string | null;
    }>(
      `SELECT id,workspace_id AS "workspaceId",order_id AS "orderId"
         FROM storefront_checkout_sessions
        WHERE ($1::uuid IS NOT NULL AND id=$1)
           OR ($2::text IS NOT NULL AND provider_session_id=$2)
           OR ($3::text IS NOT NULL AND provider_payment_intent_id=$3)
        ORDER BY CASE
          WHEN $1::uuid IS NOT NULL AND id=$1 THEN 0
          WHEN $3::text IS NOT NULL AND provider_payment_intent_id=$3 THEN 1
          ELSE 2 END
        LIMIT 1
        FOR UPDATE`,
      [input.checkoutId ?? null, input.providerPaymentLinkId ?? null, input.providerPaymentIntentId ?? null],
      client,
    );
    const checkout = session.rows[0];
    if (!checkout) return null;

    const result = await query<{ id: string; status: string; amount: string }>(
      `INSERT INTO storefront_payment_adjustments(
         workspace_id,checkout_id,provider,provider_adjustment_id,
         provider_payment_intent_id,kind,status,amount,currency,
         provider_status,provider_payload,source_event_id,occurred_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::timestamptz)
       ON CONFLICT (workspace_id,provider,provider_adjustment_id)
       DO UPDATE SET status=EXCLUDED.status,
         amount=EXCLUDED.amount,
         currency=EXCLUDED.currency,
         provider_status=EXCLUDED.provider_status,
         provider_payment_intent_id=COALESCE(EXCLUDED.provider_payment_intent_id, storefront_payment_adjustments.provider_payment_intent_id),
         provider_payload=EXCLUDED.provider_payload,
         occurred_at=COALESCE(EXCLUDED.occurred_at, storefront_payment_adjustments.occurred_at),
         updated_at=NOW()
       RETURNING id,status,amount::text`,
      [
        checkout.workspaceId,
        checkout.id,
        input.provider,
        input.providerAdjustmentId,
        input.providerPaymentIntentId ?? null,
        input.kind,
        input.status,
        input.amount,
        input.currency.toUpperCase(),
        input.providerStatus.slice(0, 80),
        JSON.stringify(input.providerPayload),
        input.sourceEventId,
        input.occurredAt ?? null,
      ],
      client,
    );
    const adjustment = result.rows[0];
    if (!adjustment) throw new Error('Storefront payment adjustment was not saved');
    return {
      checkoutId: checkout.id,
      workspaceId: checkout.workspaceId,
      orderId: checkout.orderId,
      adjustmentId: adjustment.id,
      status: adjustment.status,
      amount: adjustment.amount,
    };
  });
}

export async function createContactRequest(slug: string, email: string, requestDetails: StorefrontRequestDetails) {
  const site = await siteBySlug(slug);
  if (!site) return null;
  const id = await persistContactRequest(site, email, requestDetails, null);
  await ensureStorefrontContact(site.workspaceId, email).catch(() => null);
  return { id, status: 'NEW', message: 'Anfrage erhalten. Das Unternehmen meldet sich bald.' };
}
