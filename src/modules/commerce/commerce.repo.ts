import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { AppError, badRequest, conflictError, notFoundError } from '../../utils/app-error.js';
import type {
  AdjustInventoryInput,
  CreateFulfillmentInput,
  CreateInventoryLocationInput,
  CreateOrderInput,
  ListInventoryLevelsQuery,
  ListInventoryMovementsQuery,
  ListOrdersQuery,
  TransitionFulfillmentInput,
  TransitionOrderInput,
  UpdateInventoryLocationInput,
  UpdateOrderInput,
} from './commerce.validator.js';
import {
  COMMERCE_EVENT_TYPES,
  type CommerceActor,
  type CommerceOperationReplay,
  type FulfillmentStatus,
  type OrderStatus,
} from './commerce.types.js';

const orderSelect = `
  o.id,
  o.workspace_id AS "workspaceId",
  o.order_number AS "orderNumber",
  o.status,
  o.payment_status AS "paymentStatus",
  o.fulfillment_status AS "fulfillmentStatus",
  o.customer_record_id AS "customerRecordId",
  o.company_record_id AS "companyRecordId",
  o.quote_id AS "quoteId",
  o.currency,
  o.subtotal,
  o.discount_total AS "discountTotal",
  o.shipping_total AS "shippingTotal",
  o.tax_total AS "taxTotal",
  o.grand_total AS "grandTotal",
  o.source,
  o.source_provider AS "sourceProvider",
  o.external_reference AS "externalReference",
  o.notes,
  o.shipping_address AS "shippingAddress",
  o.billing_address AS "billingAddress",
  o.metadata,
  o.version,
  o.placed_at AS "placedAt",
  o.confirmed_at AS "confirmedAt",
  o.cancelled_at AS "cancelledAt",
  o.completed_at AS "completedAt",
  o.created_by_actor_type AS "createdByActorType",
  o.created_by_actor_ref AS "createdByActorRef",
  o.created_at AS "createdAt",
  o.updated_at AS "updatedAt"
`;

const orderLineSelect = `
  l.id,
  l.workspace_id AS "workspaceId",
  l.order_id AS "orderId",
  l.product_id AS "productId",
  l.variant_id AS "variantId",
  l.inventory_location_id AS "inventoryLocationId",
  l.sku_snapshot AS "sku",
  l.product_name_snapshot AS "productName",
  l.description_snapshot AS "description",
  l.quantity,
  l.quantity_unit AS "quantityUnit",
  l.unit_price AS "unitPrice",
  l.discount,
  l.tax,
  l.line_total AS "lineTotal",
  l.reserved_quantity AS "reservedQuantity",
  l.fulfilled_quantity AS "fulfilledQuantity",
  l.metadata,
  l.sort_order AS "sortOrder",
  l.version,
  l.created_at AS "createdAt",
  l.updated_at AS "updatedAt"
`;

const locationSelect = `
  l.id,
  l.workspace_id AS "workspaceId",
  l.code,
  l.name,
  l.status,
  l.is_default AS "isDefault",
  l.address,
  l.metadata,
  l.version,
  l.created_by_actor_type AS "createdByActorType",
  l.created_by_actor_ref AS "createdByActorRef",
  l.created_at AS "createdAt",
  l.updated_at AS "updatedAt"
`;

const inventoryLevelSelect = `
  il.id,
  il.workspace_id AS "workspaceId",
  il.location_id AS "locationId",
  loc.code AS "locationCode",
  loc.name AS "locationName",
  il.product_id AS "productId",
  p.name AS "productName",
  il.variant_id AS "variantId",
  pv.name AS "variantName",
  COALESCE(pv.sku, p.sku) AS sku,
  il.on_hand AS "onHand",
  il.reserved,
  (il.on_hand - il.reserved) AS available,
  il.reorder_point AS "reorderPoint",
  il.version,
  il.created_at AS "createdAt",
  il.updated_at AS "updatedAt"
`;

const fulfillmentSelect = `
  f.id,
  f.workspace_id AS "workspaceId",
  f.order_id AS "orderId",
  f.fulfillment_number AS "fulfillmentNumber",
  f.status,
  f.carrier,
  f.tracking_number AS "trackingNumber",
  f.tracking_url AS "trackingUrl",
  f.notes,
  f.metadata,
  f.version,
  f.shipped_at AS "shippedAt",
  f.delivered_at AS "deliveredAt",
  f.cancelled_at AS "cancelledAt",
  f.created_by_actor_type AS "createdByActorType",
  f.created_by_actor_ref AS "createdByActorRef",
  f.created_at AS "createdAt",
  f.updated_at AS "updatedAt"
`;

type OrderLockRow = { id: string; status: OrderStatus; version: number; orderNumber: string; currency: string };
type LevelLockRow = {
  id: string;
  onHand: string;
  reserved: string;
  version: number;
  productId: string;
  variantId: string | null;
  locationId: string;
};
type OrderLineLockRow = {
  id: string;
  productId: string;
  variantId: string | null;
  inventoryLocationId: string | null;
  quantity: string;
  reservedQuantity: string;
  fulfilledQuantity: string;
};
type FulfillmentLockRow = { id: string; status: FulfillmentStatus; version: number };
type CommerceOrderRow = {
  id: string;
  workspaceId: string;
  orderNumber: string;
  status: OrderStatus;
  fulfillmentStatus: string;
  currency: string;
  version: number;
  createdByActorType: CommerceActor['actorType'];
  createdByActorRef: string | null;
  [column: string]: unknown;
};
type CommerceOrderLineRow = {
  id: string;
  workspaceId: string;
  orderId: string;
  productId: string;
  version: number;
  [column: string]: unknown;
};
type CommerceFulfillmentRow = {
  id: string;
  workspaceId: string;
  orderId: string;
  status: FulfillmentStatus;
  version: number;
  [column: string]: unknown;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function requestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function derivedOperationKey(base: string, suffix: string) {
  const candidate = `${base}:${suffix}`;
  return candidate.length <= 200
    ? candidate
    : `derived:${createHash('sha256').update(candidate).digest('hex')}`;
}

function decimalUnits(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) throw new Error(`Invalid stored commerce decimal: ${value}`);
  const whole = BigInt(match[2]!);
  const fraction = BigInt((match[3] ?? '').padEnd(4, '0'));
  const units = whole * 10_000n + fraction;
  return match[1] === '-' ? -units : units;
}

function decimalFromUnits(value: bigint) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 10_000n;
  const fraction = String(absolute % 10_000n).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

function userActorId(actor: CommerceActor) {
  return actor.actorType === 'USER' || actor.actorType === 'ADMIN' ? actor.actorRef ?? null : null;
}

function eventMetadata(actor: CommerceActor) {
  return {
    actorId: actor.actorRef ?? null,
    source: 'canonical-commerce',
    correlationId: actor.correlationId ?? null,
    causationId: actor.causationId ?? null,
    actorType: actor.actorType,
  };
}

function versionConflict(entity: string) {
  return new AppError(409, 'VERSION_CONFLICT', `${entity} changed since it was loaded`);
}

function insufficientStock(details: Record<string, unknown>) {
  return new AppError(409, 'INSUFFICIENT_STOCK', 'The requested quantity is no longer available', details);
}

function idempotencyConflict() {
  return new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for another request');
}

function databaseCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

async function claimOperation(
  client: PoolClient,
  workspaceId: string,
  operationKey: string,
  operationType: string,
  hash: string,
  actor: CommerceActor,
): Promise<CommerceOperationReplay> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO commerce_operations(
       workspace_id,operation_key,operation_type,request_hash,actor_type,actor_ref
     ) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id,operation_key) DO NOTHING
     RETURNING id`,
    [workspaceId, operationKey, operationType, hash, actor.actorType, actor.actorRef ?? null],
    client,
  );
  if (inserted.rows[0]) return { replayed: false, resourceId: null };

  const existing = await query<{
    operationType: string;
    requestHash: string;
    status: 'STARTED' | 'COMPLETED';
    resourceId: string | null;
  }>(
    `SELECT operation_type AS "operationType",request_hash AS "requestHash",status,
            resource_id AS "resourceId"
       FROM commerce_operations
      WHERE workspace_id=$1 AND operation_key=$2`,
    [workspaceId, operationKey],
    client,
  );
  const operation = existing.rows[0];
  if (!operation || operation.operationType !== operationType || operation.requestHash !== hash) {
    throw idempotencyConflict();
  }
  if (operation.status !== 'COMPLETED') {
    throw new AppError(409, 'OPERATION_IN_PROGRESS', 'This commerce operation is still in progress');
  }
  return { replayed: true, resourceId: operation.resourceId };
}

async function completeOperation(
  client: PoolClient,
  workspaceId: string,
  operationKey: string,
  resourceType: string,
  resourceId: string,
  result: Record<string, unknown> = {},
) {
  await query(
    `UPDATE commerce_operations
        SET status='COMPLETED',resource_type=$3,resource_id=$4,result=$5::jsonb,completed_at=NOW()
      WHERE workspace_id=$1 AND operation_key=$2 AND status='STARTED'`,
    [workspaceId, operationKey, resourceType, resourceId, JSON.stringify(result)],
    client,
  );
}

async function appendAudit(
  client: PoolClient,
  workspaceId: string,
  actor: CommerceActor,
  action: string,
  entityType: string,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  await query(
    `INSERT INTO audit_log(
       workspace_id,actor_id,action,entity_type,entity_id,before_data,after_data
     ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [
      workspaceId,
      userActorId(actor),
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify({ ...after, actorType: actor.actorType, actorRef: actor.actorRef ?? null }) : null,
    ],
    client,
  );
}

async function emitEvent(
  client: PoolClient,
  workspaceId: string,
  actor: CommerceActor,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  return appendDomainEvent({
    workspaceId,
    type,
    aggregateType,
    aggregateId,
    payload,
    metadata: eventMetadata(actor),
    idempotencyKey,
  }, client);
}

async function nextNumber(client: PoolClient, workspaceId: string, type: 'ORDER' | 'FULFILLMENT') {
  await query(
    `INSERT INTO commerce_sequences(workspace_id,sequence_type,next_value)
     VALUES($1,$2,1) ON CONFLICT DO NOTHING`,
    [workspaceId, type],
    client,
  );
  const result = await query<{ value: string }>(
    `UPDATE commerce_sequences
        SET next_value=next_value+1
      WHERE workspace_id=$1 AND sequence_type=$2
      RETURNING (next_value-1)::text AS value`,
    [workspaceId, type],
    client,
  );
  return Number(result.rows[0]?.value ?? 1);
}

async function assertReference(
  client: PoolClient,
  workspaceId: string,
  recordId: string | null | undefined,
  allowedTypes: readonly string[],
  label: string,
) {
  if (!recordId) return;
  const result = await query<{ resourceType: string }>(
    `SELECT resource_type AS "resourceType"
       FROM workspace_records
      WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [workspaceId, recordId],
    client,
  );
  if (!result.rows[0]) throw notFoundError(`${label} not found`);
  if (!allowedTypes.includes(result.rows[0].resourceType)) {
    throw conflictError(`${label} has an incompatible record type`);
  }
}

async function assertOrderReferences(
  client: PoolClient,
  workspaceId: string,
  input: {
    customerRecordId?: string | null | undefined;
    companyRecordId?: string | null | undefined;
    quoteId?: string | null | undefined;
  },
) {
  await assertReference(
    client,
    workspaceId,
    input.customerRecordId,
    ['customers', 'crm_contacts', 'ecommerce_customers', 'finance_customers'],
    'Customer',
  );
  await assertReference(client, workspaceId, input.companyRecordId, ['crm_companies'], 'Company');
  if (input.quoteId) {
    const quote = await query(
      `SELECT 1 FROM quotes WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, input.quoteId],
      client,
    );
    if (!quote.rows[0]) throw notFoundError('Quote not found');
  }
}

type PreparedLine = {
  productId: string;
  variantId: string | null;
  inventoryLocationId: string | null;
  sku: string | null;
  productName: string;
  description: string | null;
  quantity: string;
  quantityUnit: string | null;
  unitPrice: string;
  discount: string;
  tax: string;
  metadata: Record<string, unknown>;
  sortOrder: number;
};

async function prepareOrderLines(
  client: PoolClient,
  workspaceId: string,
  currency: string,
  lines: CreateOrderInput['lines'] | NonNullable<UpdateOrderInput['lines']>,
): Promise<PreparedLine[]> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const variantIds = [...new Set(lines.flatMap((line) => line.variantId ? [line.variantId] : []))];
  const locationIds = [...new Set(lines.flatMap((line) => line.inventoryLocationId ? [line.inventoryLocationId] : []))];

  const products = await query<{
    id: string;
    status: string;
    sku: string | null;
    name: string;
    description: string | null;
    defaultPrice: string | null;
    defaultCurrency: string | null;
  }>(
    `SELECT id,status,sku,name,short_description AS description,
            default_price AS "defaultPrice",default_currency AS "defaultCurrency"
       FROM products
      WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,
    [workspaceId, productIds],
    client,
  );
  const productMap = new Map(products.rows.map((product) => [product.id, product]));

  const variants = variantIds.length === 0 ? { rows: [] as Array<{
    id: string;
    productId: string;
    status: string;
    sku: string | null;
    name: string;
    defaultPrice: string | null;
    defaultCurrency: string | null;
  }> } : await query<{
    id: string;
    productId: string;
    status: string;
    sku: string | null;
    name: string;
    defaultPrice: string | null;
    defaultCurrency: string | null;
  }>(
    `SELECT id,product_id AS "productId",status,sku,name,
            default_price AS "defaultPrice",default_currency AS "defaultCurrency"
       FROM product_variants
      WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
    [workspaceId, variantIds],
    client,
  );
  const variantMap = new Map(variants.rows.map((variant) => [variant.id, variant]));

  if (locationIds.length > 0) {
    const locations = await query<{ id: string }>(
      `SELECT id FROM inventory_locations
        WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE'`,
      [workspaceId, locationIds],
      client,
    );
    const active = new Set(locations.rows.map((location) => location.id));
    const missing = locationIds.find((locationId) => !active.has(locationId));
    if (missing) throw notFoundError('Active inventory location not found');
  }

  return lines.map((line, sortOrder) => {
    const product = productMap.get(line.productId);
    if (!product) throw notFoundError('Product not found');
    if (product.status !== 'ACTIVE') throw conflictError(`Product ${product.name} is not active`);
    const variant = line.variantId ? variantMap.get(line.variantId) : null;
    if (line.variantId && (!variant || variant.productId !== product.id)) {
      throw notFoundError('Product variant not found');
    }
    if (variant && variant.status !== 'ACTIVE') throw conflictError(`Product variant ${variant.name} is not active`);
    const catalogPrice = variant?.defaultPrice ?? product.defaultPrice;
    const catalogCurrency = variant?.defaultCurrency ?? product.defaultCurrency;
    if (line.unitPrice === undefined && catalogPrice === null) {
      throw badRequest(`A unit price is required for product ${product.name}`);
    }
    if (line.unitPrice === undefined && catalogCurrency && catalogCurrency !== currency) {
      throw conflictError(`Catalog price for product ${product.name} is in ${catalogCurrency}, not ${currency}`);
    }
    const unitPrice = line.unitPrice ?? catalogPrice!;
    if (decimalUnits(line.discount) * 10_000n > decimalUnits(line.quantity) * decimalUnits(unitPrice)) {
      throw badRequest(`Discount exceeds subtotal for product ${product.name}`);
    }
    return {
      productId: product.id,
      variantId: variant?.id ?? null,
      inventoryLocationId: line.inventoryLocationId ?? null,
      sku: variant?.sku ?? product.sku,
      productName: variant ? `${product.name} — ${variant.name}` : product.name,
      description: product.description,
      quantity: line.quantity,
      quantityUnit: line.quantityUnit ?? null,
      unitPrice,
      discount: line.discount,
      tax: line.tax,
      metadata: line.metadata,
      sortOrder,
    };
  });
}

async function insertOrderLines(
  client: PoolClient,
  workspaceId: string,
  orderId: string,
  lines: PreparedLine[],
) {
  for (const line of lines) {
    await query(
      `INSERT INTO commerce_order_lines(
         workspace_id,order_id,product_id,variant_id,inventory_location_id,
         sku_snapshot,product_name_snapshot,description_snapshot,quantity,
         quantity_unit,unit_price,discount,tax,metadata,sort_order
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
      [
        workspaceId,
        orderId,
        line.productId,
        line.variantId,
        line.inventoryLocationId,
        line.sku,
        line.productName,
        line.description,
        line.quantity,
        line.quantityUnit,
        line.unitPrice,
        line.discount,
        line.tax,
        JSON.stringify(line.metadata),
        line.sortOrder,
      ],
      client,
    );
  }
}

async function recalculateOrderTotals(client: PoolClient, workspaceId: string, orderId: string) {
  await query(
    `UPDATE commerce_orders o SET
       subtotal=COALESCE((SELECT SUM(l.quantity*l.unit_price) FROM commerce_order_lines l WHERE l.workspace_id=o.workspace_id AND l.order_id=o.id),0),
       discount_total=COALESCE((SELECT SUM(l.discount) FROM commerce_order_lines l WHERE l.workspace_id=o.workspace_id AND l.order_id=o.id),0),
       tax_total=COALESCE((SELECT SUM(l.tax) FROM commerce_order_lines l WHERE l.workspace_id=o.workspace_id AND l.order_id=o.id),0),
       grand_total=GREATEST(0,COALESCE((SELECT SUM(l.line_total) FROM commerce_order_lines l WHERE l.workspace_id=o.workspace_id AND l.order_id=o.id),0)+o.shipping_total)
     WHERE o.workspace_id=$1 AND o.id=$2`,
    [workspaceId, orderId],
    client,
  );
}

export async function listOrders(workspaceId: string, filters: ListOrdersQuery) {
  const values: unknown[] = [workspaceId];
  const where = ['o.workspace_id=$1'];
  if (filters.status) {
    values.push(filters.status);
    where.push(`o.status=$${values.length}`);
  }
  if (filters.customerRecordId) {
    values.push(filters.customerRecordId);
    where.push(`o.customer_record_id=$${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search}%`);
    where.push(`(o.order_number ILIKE $${values.length} OR COALESCE(o.external_reference,'') ILIKE $${values.length})`);
  }
  const total = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM commerce_orders o WHERE ${where.join(' AND ')}`,
    values,
  );
  const sortColumns = {
    createdAt: 'o.created_at',
    updatedAt: 'o.updated_at',
    orderNumber: 'o.order_number',
    grandTotal: 'o.grand_total',
  } as const;
  values.push(filters.limit, (filters.page - 1) * filters.limit);
  const rows = await query(
    `SELECT ${orderSelect},count(l.id)::integer AS "lineCount"
       FROM commerce_orders o
       LEFT JOIN commerce_order_lines l ON l.workspace_id=o.workspace_id AND l.order_id=o.id
      WHERE ${where.join(' AND ')}
      GROUP BY o.id
      ORDER BY ${sortColumns[filters.sort]} ${filters.order.toUpperCase()},o.id ${filters.order.toUpperCase()}
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const count = Number(total.rows[0]?.total ?? 0);
  return {
    items: rows.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: count,
      pages: Math.ceil(count / filters.limit),
    },
  };
}

export async function getOrder(workspaceId: string, orderId: string, client?: PoolClient) {
  const order = await query<CommerceOrderRow>(
    `SELECT ${orderSelect} FROM commerce_orders o WHERE o.workspace_id=$1 AND o.id=$2`,
    [workspaceId, orderId],
    client,
  );
  if (!order.rows[0]) return null;
  const lines = await query<CommerceOrderLineRow>(
    `SELECT ${orderLineSelect}
       FROM commerce_order_lines l
      WHERE l.workspace_id=$1 AND l.order_id=$2
      ORDER BY l.sort_order,l.id`,
    [workspaceId, orderId],
    client,
  );
  const fulfillments = await query<CommerceFulfillmentRow>(
    `SELECT ${fulfillmentSelect}
       FROM commerce_fulfillments f
      WHERE f.workspace_id=$1 AND f.order_id=$2
      ORDER BY f.created_at DESC`,
    [workspaceId, orderId],
    client,
  );
  return { order: order.rows[0], lines: lines.rows, fulfillments: fulfillments.rows };
}

export async function createOrder(workspaceId: string, actor: CommerceActor, input: CreateOrderInput) {
  try {
    const orderId = await withTransaction(async (client) => {
      const hash = requestHash(input);
      const operation = await claimOperation(client, workspaceId, input.idempotencyKey, 'order.create', hash, actor);
      if (operation.replayed) {
        if (!operation.resourceId) throw idempotencyConflict();
        return operation.resourceId;
      }
      await assertOrderReferences(client, workspaceId, input);
      const lines = await prepareOrderLines(client, workspaceId, input.currency, input.lines);
      const sequence = await nextNumber(client, workspaceId, 'ORDER');
      const orderNumber = `ORD-${new Date().getUTCFullYear()}-${String(sequence).padStart(7, '0')}`;
      const inserted = await query<{ id: string }>(
        `INSERT INTO commerce_orders(
           workspace_id,order_number,customer_record_id,company_record_id,quote_id,
           currency,shipping_total,source,source_provider,external_reference,notes,
           shipping_address,billing_address,metadata,created_by,updated_by,
           created_by_actor_type,created_by_actor_ref
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$15,$16,$17)
         RETURNING id`,
        [
          workspaceId,
          orderNumber,
          input.customerRecordId ?? null,
          input.companyRecordId ?? null,
          input.quoteId ?? null,
          input.currency,
          input.shippingTotal,
          input.source,
          input.sourceProvider ?? null,
          input.externalReference ?? null,
          input.notes ?? null,
          JSON.stringify(input.shippingAddress),
          JSON.stringify(input.billingAddress),
          JSON.stringify(input.metadata),
          userActorId(actor),
          actor.actorType,
          actor.actorRef ?? null,
        ],
        client,
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('Order insert did not return an id');
      await insertOrderLines(client, workspaceId, id, lines);
      await recalculateOrderTotals(client, workspaceId, id);
      await appendAudit(client, workspaceId, actor, 'order.created', 'commerce_order', id, null, {
        orderNumber,
        status: 'DRAFT',
        lineCount: lines.length,
      });
      await emitEvent(
        client,
        workspaceId,
        actor,
        COMMERCE_EVENT_TYPES.ORDER_CREATED,
        'commerce_order',
        id,
        { orderId: id, orderNumber, status: 'DRAFT', lineCount: lines.length },
        `commerce:order:${id}:created`,
      );
      await completeOperation(client, workspaceId, input.idempotencyKey, 'commerce_order', id, { orderId: id });
      return id;
    });
    return getOrder(workspaceId, orderId);
  } catch (error) {
    if (databaseCode(error) === '23505') throw conflictError('Order number, provider reference, or idempotency key already exists');
    throw error;
  }
}

export async function updateOrder(
  workspaceId: string,
  orderId: string,
  actor: CommerceActor,
  input: UpdateOrderInput,
) {
  const resultId = await withTransaction(async (client) => {
    const operationType = `order.update:${orderId}`;
    const operation = await claimOperation(
      client,
      workspaceId,
      input.idempotencyKey,
      operationType,
      requestHash(input),
      actor,
    );
    if (operation.replayed) return operation.resourceId ?? orderId;
    const locked = await query<OrderLockRow & { shippingTotal: string }>(
      `SELECT id,status,version,order_number AS "orderNumber",currency,shipping_total AS "shippingTotal"
         FROM commerce_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, orderId],
      client,
    );
    const order = locked.rows[0];
    if (!order) throw notFoundError('Order not found');
    if (order.version !== input.expectedVersion) throw versionConflict('Order');
    if (order.status !== 'DRAFT') throw conflictError('Only draft orders can be edited');
    await assertOrderReferences(client, workspaceId, input);

    const currency = input.currency ?? order.currency;
    if (input.currency && input.currency !== order.currency && !input.lines) {
      throw conflictError('Changing order currency requires replacement lines with prices in the new currency');
    }
    const preparedLines = input.lines
      ? await prepareOrderLines(client, workspaceId, currency, input.lines)
      : null;
    const assignments: string[] = [];
    const values: unknown[] = [workspaceId, orderId];
    const fields: Array<[keyof UpdateOrderInput, string, string?]> = [
      ['customerRecordId', 'customer_record_id'],
      ['companyRecordId', 'company_record_id'],
      ['quoteId', 'quote_id'],
      ['currency', 'currency'],
      ['shippingTotal', 'shipping_total'],
      ['notes', 'notes'],
      ['shippingAddress', 'shipping_address', '::jsonb'],
      ['billingAddress', 'billing_address', '::jsonb'],
      ['metadata', 'metadata', '::jsonb'],
    ];
    for (const [key, column, cast = ''] of fields) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const raw = input[key];
      values.push(cast ? JSON.stringify(raw ?? {}) : raw ?? null);
      assignments.push(`${column}=$${values.length}${cast}`);
    }
    values.push(userActorId(actor), input.expectedVersion);
    const updated = await query<{ id: string }>(
      `UPDATE commerce_orders SET
         ${assignments.length > 0 ? `${assignments.join(',')},` : ''}
         updated_by=$${values.length - 1},version=version+1
       WHERE workspace_id=$1 AND id=$2 AND version=$${values.length}
       RETURNING id`,
      values,
      client,
    );
    if (!updated.rows[0]) throw versionConflict('Order');
    if (preparedLines) {
      await query(`DELETE FROM commerce_order_lines WHERE workspace_id=$1 AND order_id=$2`, [workspaceId, orderId], client);
      await insertOrderLines(client, workspaceId, orderId, preparedLines);
    }
    await recalculateOrderTotals(client, workspaceId, orderId);
    await appendAudit(
      client,
      workspaceId,
      actor,
      'order.updated',
      'commerce_order',
      orderId,
      { status: order.status, version: order.version },
      { status: order.status, version: order.version + 1, linesReplaced: Boolean(preparedLines) },
    );
    await emitEvent(
      client,
      workspaceId,
      actor,
      COMMERCE_EVENT_TYPES.ORDER_UPDATED,
      'commerce_order',
      orderId,
      { orderId, orderNumber: order.orderNumber, version: order.version + 1 },
      `commerce:operation:${input.idempotencyKey}:event`,
    );
    await completeOperation(client, workspaceId, input.idempotencyKey, 'commerce_order', orderId, { orderId });
    return orderId;
  });
  return getOrder(workspaceId, resultId);
}

async function getLevelForLine(
  client: PoolClient,
  workspaceId: string,
  line: Pick<OrderLineLockRow, 'productId' | 'variantId' | 'inventoryLocationId'>,
  requireActiveLocation = false,
) {
  if (!line.inventoryLocationId) return null;
  const level = await query<LevelLockRow>(
    `SELECT il.id,il.on_hand AS "onHand",il.reserved,il.version,il.product_id AS "productId",
            il.variant_id AS "variantId",il.location_id AS "locationId"
       FROM inventory_levels il
       JOIN inventory_locations loc
         ON loc.workspace_id=il.workspace_id AND loc.id=il.location_id
      WHERE il.workspace_id=$1 AND il.location_id=$2 AND il.product_id=$3
        AND il.variant_id IS NOT DISTINCT FROM $4::uuid
        AND ($5::boolean=FALSE OR loc.status='ACTIVE')
      FOR UPDATE OF il`,
    [workspaceId, line.inventoryLocationId, line.productId, line.variantId, requireActiveLocation],
    client,
  );
  return level.rows[0] ?? null;
}

async function appendMovement(
  client: PoolClient,
  input: {
    workspaceId: string;
    levelId: string;
    movementType: 'INITIAL' | 'ADJUSTMENT' | 'RESERVATION' | 'RELEASE' | 'FULFILLMENT' | 'RETURN';
    onHandDelta: string;
    reservedDelta: string;
    onHandBefore: string;
    onHandAfter: string;
    reservedBefore: string;
    reservedAfter: string;
    orderId?: string | null;
    orderLineId?: string | null;
    fulfillmentId?: string | null;
    reason: string;
    operationKey: string;
    metadata?: Record<string, unknown>;
  },
  actor: CommerceActor,
) {
  await query(
    `INSERT INTO inventory_movements(
       workspace_id,inventory_level_id,movement_type,on_hand_delta,reserved_delta,
       on_hand_before,on_hand_after,reserved_before,reserved_after,order_id,
       order_line_id,fulfillment_id,reason,operation_key,actor_type,actor_ref,metadata
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
    [
      input.workspaceId,
      input.levelId,
      input.movementType,
      input.onHandDelta,
      input.reservedDelta,
      input.onHandBefore,
      input.onHandAfter,
      input.reservedBefore,
      input.reservedAfter,
      input.orderId ?? null,
      input.orderLineId ?? null,
      input.fulfillmentId ?? null,
      input.reason,
      input.operationKey,
      actor.actorType,
      actor.actorRef ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
    client,
  );
}

async function reserveOrderInventory(
  client: PoolClient,
  workspaceId: string,
  orderId: string,
  orderNumber: string,
  operationKey: string,
  actor: CommerceActor,
) {
  const lines = await query<OrderLineLockRow>(
    `SELECT id,product_id AS "productId",variant_id AS "variantId",
            inventory_location_id AS "inventoryLocationId",quantity,
            reserved_quantity AS "reservedQuantity",fulfilled_quantity AS "fulfilledQuantity"
       FROM commerce_order_lines
      WHERE workspace_id=$1 AND order_id=$2
      ORDER BY id FOR UPDATE`,
    [workspaceId, orderId],
    client,
  );
  for (const line of lines.rows) {
    if (!line.inventoryLocationId) continue;
    const level = await getLevelForLine(client, workspaceId, line, true);
    if (!level) {
      throw insufficientStock({ orderId, orderLineId: line.id, available: '0', requested: line.quantity });
    }
    const changed = await query<{ onHand: string; reservedBefore: string; reservedAfter: string }>(
      `UPDATE inventory_levels
          SET reserved=reserved+$3::numeric,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND on_hand-reserved >= $3::numeric
        RETURNING on_hand AS "onHand",(reserved-$3::numeric)::text AS "reservedBefore",reserved::text AS "reservedAfter"`,
      [workspaceId, level.id, line.quantity],
      client,
    );
    const state = changed.rows[0];
    if (!state) {
      throw insufficientStock({
        orderId,
        orderLineId: line.id,
        inventoryLevelId: level.id,
        available: decimalFromUnits(decimalUnits(level.onHand) - decimalUnits(level.reserved)),
        requested: line.quantity,
      });
    }
    await query(
      `UPDATE commerce_order_lines
          SET reserved_quantity=quantity,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND order_id=$3`,
      [workspaceId, line.id, orderId],
      client,
    );
    await appendMovement(client, {
      workspaceId,
      levelId: level.id,
      movementType: 'RESERVATION',
      onHandDelta: '0',
      reservedDelta: line.quantity,
      onHandBefore: state.onHand,
      onHandAfter: state.onHand,
      reservedBefore: state.reservedBefore,
      reservedAfter: state.reservedAfter,
      orderId,
      orderLineId: line.id,
      reason: `Inventory reserved for ${orderNumber}`,
      operationKey: derivedOperationKey(operationKey, `reserve:${line.id}`),
    }, actor);
    await emitEvent(
      client,
      workspaceId,
      actor,
      COMMERCE_EVENT_TYPES.INVENTORY_RESERVED,
      'inventory_level',
      level.id,
      { inventoryLevelId: level.id, orderId, orderLineId: line.id, quantity: line.quantity },
      `commerce:operation:${operationKey}:reserve:${line.id}`,
    );
  }
}

async function releaseOrderInventory(
  client: PoolClient,
  workspaceId: string,
  orderId: string,
  orderNumber: string,
  operationKey: string,
  actor: CommerceActor,
) {
  const lines = await query<OrderLineLockRow>(
    `SELECT id,product_id AS "productId",variant_id AS "variantId",
            inventory_location_id AS "inventoryLocationId",quantity,
            reserved_quantity AS "reservedQuantity",fulfilled_quantity AS "fulfilledQuantity"
       FROM commerce_order_lines
      WHERE workspace_id=$1 AND order_id=$2
      ORDER BY id FOR UPDATE`,
    [workspaceId, orderId],
    client,
  );
  for (const line of lines.rows) {
    if (!line.inventoryLocationId || decimalUnits(line.reservedQuantity) <= 0n) continue;
    const level = await getLevelForLine(client, workspaceId, line);
    if (!level) throw new Error('Reserved inventory level is missing');
    const changed = await query<{ onHand: string; reservedBefore: string; reservedAfter: string }>(
      `UPDATE inventory_levels
          SET reserved=reserved-$3::numeric,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND reserved >= $3::numeric
        RETURNING on_hand AS "onHand",(reserved+$3::numeric)::text AS "reservedBefore",reserved::text AS "reservedAfter"`,
      [workspaceId, level.id, line.reservedQuantity],
      client,
    );
    const state = changed.rows[0];
    if (!state) throw new Error('Reserved inventory state is inconsistent');
    await query(
      `UPDATE commerce_order_lines
          SET reserved_quantity=0,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND order_id=$3`,
      [workspaceId, line.id, orderId],
      client,
    );
    await appendMovement(client, {
      workspaceId,
      levelId: level.id,
      movementType: 'RELEASE',
      onHandDelta: '0',
      reservedDelta: `-${line.reservedQuantity}`,
      onHandBefore: state.onHand,
      onHandAfter: state.onHand,
      reservedBefore: state.reservedBefore,
      reservedAfter: state.reservedAfter,
      orderId,
      orderLineId: line.id,
      reason: `Outstanding inventory released for cancelled ${orderNumber}`,
      operationKey: derivedOperationKey(operationKey, `release:${line.id}`),
    }, actor);
    await emitEvent(
      client,
      workspaceId,
      actor,
      COMMERCE_EVENT_TYPES.INVENTORY_RELEASED,
      'inventory_level',
      level.id,
      { inventoryLevelId: level.id, orderId, orderLineId: line.id, quantity: line.reservedQuantity },
      `commerce:operation:${operationKey}:release:${line.id}`,
    );
  }
}

const orderTransitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['PLACED', 'CANCELLED'],
  PLACED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['CANCELLED'],
  PARTIALLY_FULFILLED: ['CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
};

const orderTransitionEvents: Partial<Record<OrderStatus, string>> = {
  PLACED: COMMERCE_EVENT_TYPES.ORDER_PLACED,
  CONFIRMED: COMMERCE_EVENT_TYPES.ORDER_CONFIRMED,
  PROCESSING: COMMERCE_EVENT_TYPES.ORDER_PROCESSING,
  CANCELLED: COMMERCE_EVENT_TYPES.ORDER_CANCELLED,
};

export async function transitionOrder(
  workspaceId: string,
  orderId: string,
  actor: CommerceActor,
  input: TransitionOrderInput,
) {
  const resultId = await withTransaction(async (client) => {
    const operationType = `order.transition:${orderId}:${input.targetStatus}`;
    const operation = await claimOperation(
      client,
      workspaceId,
      input.idempotencyKey,
      operationType,
      requestHash(input),
      actor,
    );
    if (operation.replayed) return operation.resourceId ?? orderId;
    const locked = await query<OrderLockRow>(
      `SELECT id,status,version,order_number AS "orderNumber",currency
         FROM commerce_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, orderId],
      client,
    );
    const order = locked.rows[0];
    if (!order) throw notFoundError('Order not found');
    if (order.version !== input.expectedVersion) throw versionConflict('Order');
    if (!orderTransitions[order.status].includes(input.targetStatus)) {
      throw conflictError(`Order cannot transition from ${order.status} to ${input.targetStatus}`);
    }

    if (input.targetStatus === 'CONFIRMED') {
      await reserveOrderInventory(client, workspaceId, orderId, order.orderNumber, input.idempotencyKey, actor);
    } else if (input.targetStatus === 'CANCELLED') {
      await releaseOrderInventory(client, workspaceId, orderId, order.orderNumber, input.idempotencyKey, actor);
      const cancelledFulfillments = await query<{
        id: string;
        previousStatus: FulfillmentStatus;
        version: number;
      }>(
        `WITH candidates AS (
           SELECT id,status FROM commerce_fulfillments
            WHERE workspace_id=$1 AND order_id=$2 AND status IN ('DRAFT','PROCESSING')
            FOR UPDATE
         )
         UPDATE commerce_fulfillments f
            SET status='CANCELLED',cancelled_at=NOW(),version=f.version+1,updated_by=$3
           FROM candidates c
          WHERE f.workspace_id=$1 AND f.order_id=$2 AND f.id=c.id
          RETURNING f.id,c.status AS "previousStatus",f.version`,
        [workspaceId, orderId, userActorId(actor)],
        client,
      );
      for (const fulfillment of cancelledFulfillments.rows) {
        await appendAudit(
          client,
          workspaceId,
          actor,
          'fulfillment.cancelled',
          'commerce_fulfillment',
          fulfillment.id,
          { status: fulfillment.previousStatus, version: fulfillment.version - 1 },
          { status: 'CANCELLED', version: fulfillment.version, reason: 'Order cancelled' },
        );
        await emitEvent(
          client,
          workspaceId,
          actor,
          COMMERCE_EVENT_TYPES.FULFILLMENT_CANCELLED,
          'commerce_fulfillment',
          fulfillment.id,
          { fulfillmentId: fulfillment.id, orderId, previousStatus: fulfillment.previousStatus, status: 'CANCELLED' },
          `commerce:operation:${input.idempotencyKey}:cancel-fulfillment:${fulfillment.id}`,
        );
      }
    }

    const timestampAssignment = input.targetStatus === 'PLACED'
      ? ',placed_at=NOW()'
      : input.targetStatus === 'CONFIRMED'
        ? ',confirmed_at=NOW()'
        : input.targetStatus === 'CANCELLED'
          ? ',cancelled_at=NOW()'
          : '';
    const changed = await query<{ version: number }>(
      `UPDATE commerce_orders
          SET status=$3,updated_by=$4,version=version+1${timestampAssignment}
        WHERE workspace_id=$1 AND id=$2 AND version=$5
        RETURNING version`,
      [workspaceId, orderId, input.targetStatus, userActorId(actor), input.expectedVersion],
      client,
    );
    if (!changed.rows[0]) throw versionConflict('Order');
    await appendAudit(
      client,
      workspaceId,
      actor,
      `order.${input.targetStatus.toLowerCase()}`,
      'commerce_order',
      orderId,
      { status: order.status, version: order.version },
      { status: input.targetStatus, version: changed.rows[0].version, reason: input.reason ?? null },
    );
    const eventType = orderTransitionEvents[input.targetStatus];
    if (!eventType) throw new Error('Order transition event is not configured');
    await emitEvent(
      client,
      workspaceId,
      actor,
      eventType,
      'commerce_order',
      orderId,
      { orderId, orderNumber: order.orderNumber, previousStatus: order.status, status: input.targetStatus },
      `commerce:operation:${input.idempotencyKey}:event`,
    );
    await completeOperation(client, workspaceId, input.idempotencyKey, 'commerce_order', orderId, {
      orderId,
      status: input.targetStatus,
    });
    return orderId;
  });
  return getOrder(workspaceId, resultId);
}

export async function listInventoryLocations(workspaceId: string, status?: string) {
  const result = await query(
    `SELECT ${locationSelect}
       FROM inventory_locations l
      WHERE l.workspace_id=$1 AND ($2::text IS NULL OR l.status=$2)
      ORDER BY l.is_default DESC,l.name,l.id`,
    [workspaceId, status ?? null],
  );
  return result.rows;
}

export async function getInventoryLocation(workspaceId: string, locationId: string, client?: PoolClient) {
  const result = await query(
    `SELECT ${locationSelect} FROM inventory_locations l WHERE l.workspace_id=$1 AND l.id=$2`,
    [workspaceId, locationId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function createInventoryLocation(
  workspaceId: string,
  actor: CommerceActor,
  input: CreateInventoryLocationInput,
) {
  try {
    const id = await withTransaction(async (client) => {
      const operation = await claimOperation(
        client,
        workspaceId,
        input.idempotencyKey,
        'inventory_location.create',
        requestHash(input),
        actor,
      );
      if (operation.replayed) {
        if (!operation.resourceId) throw idempotencyConflict();
        return operation.resourceId;
      }
      if (input.isDefault) {
        await query(
          `UPDATE inventory_locations SET is_default=FALSE,version=version+1,updated_by=$2
            WHERE workspace_id=$1 AND is_default=TRUE`,
          [workspaceId, userActorId(actor)],
          client,
        );
      }
      const result = await query<{ id: string }>(
        `INSERT INTO inventory_locations(
           workspace_id,code,name,is_default,address,metadata,created_by,updated_by,
           created_by_actor_type,created_by_actor_ref
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$7,$8,$9)
         RETURNING id`,
        [
          workspaceId,
          input.code,
          input.name,
          input.isDefault,
          JSON.stringify(input.address),
          JSON.stringify(input.metadata),
          userActorId(actor),
          actor.actorType,
          actor.actorRef ?? null,
        ],
        client,
      );
      const locationId = result.rows[0]?.id;
      if (!locationId) throw new Error('Inventory location insert did not return an id');
      await appendAudit(client, workspaceId, actor, 'inventory.location.created', 'inventory_location', locationId, null, {
        code: input.code,
        name: input.name,
        isDefault: input.isDefault,
      });
      await emitEvent(
        client,
        workspaceId,
        actor,
        COMMERCE_EVENT_TYPES.INVENTORY_LOCATION_CREATED,
        'inventory_location',
        locationId,
        { locationId, code: input.code, name: input.name },
        `commerce:inventory-location:${locationId}:created`,
      );
      await completeOperation(client, workspaceId, input.idempotencyKey, 'inventory_location', locationId, { locationId });
      return locationId;
    });
    return getInventoryLocation(workspaceId, id);
  } catch (error) {
    if (databaseCode(error) === '23505') throw conflictError('An active inventory location with this code already exists');
    throw error;
  }
}

export async function updateInventoryLocation(
  workspaceId: string,
  locationId: string,
  actor: CommerceActor,
  input: UpdateInventoryLocationInput,
) {
  try {
    const resultId = await withTransaction(async (client) => {
    const operation = await claimOperation(
      client,
      workspaceId,
      input.idempotencyKey,
      `inventory_location.update:${locationId}`,
      requestHash(input),
      actor,
    );
    if (operation.replayed) return operation.resourceId ?? locationId;
    const current = await query<{ id: string; status: string; version: number; code: string; name: string }>(
      `SELECT id,status,version,code,name FROM inventory_locations
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, locationId],
      client,
    );
    const location = current.rows[0];
    if (!location) throw notFoundError('Inventory location not found');
    if (location.version !== input.expectedVersion) throw versionConflict('Inventory location');
    if (input.isDefault) {
      await query(
        `UPDATE inventory_locations SET is_default=FALSE,version=version+1,updated_by=$3
          WHERE workspace_id=$1 AND id<>$2 AND is_default=TRUE`,
        [workspaceId, locationId, userActorId(actor)],
        client,
      );
    }
    const values: unknown[] = [workspaceId, locationId];
    const assignments: string[] = [];
    const fields: Array<[keyof UpdateInventoryLocationInput, string, string?]> = [
      ['code', 'code'],
      ['name', 'name'],
      ['status', 'status'],
      ['isDefault', 'is_default'],
      ['address', 'address', '::jsonb'],
      ['metadata', 'metadata', '::jsonb'],
    ];
    for (const [key, column, cast = ''] of fields) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const raw = input[key];
      values.push(cast ? JSON.stringify(raw ?? {}) : raw ?? null);
      assignments.push(`${column}=$${values.length}${cast}`);
    }
    if (input.status && input.status !== 'ACTIVE' && input.isDefault === undefined) assignments.push('is_default=FALSE');
    values.push(userActorId(actor), input.expectedVersion);
    const updated = await query<{ id: string; version: number }>(
      `UPDATE inventory_locations SET ${assignments.join(',')},updated_by=$${values.length - 1},version=version+1
        WHERE workspace_id=$1 AND id=$2 AND version=$${values.length}
        RETURNING id,version`,
      values,
      client,
    );
    if (!updated.rows[0]) throw versionConflict('Inventory location');
    await appendAudit(
      client,
      workspaceId,
      actor,
      'inventory.location.updated',
      'inventory_location',
      locationId,
      { code: location.code, name: location.name, status: location.status, version: location.version },
      { version: updated.rows[0].version },
    );
    await emitEvent(
      client,
      workspaceId,
      actor,
      COMMERCE_EVENT_TYPES.INVENTORY_LOCATION_UPDATED,
      'inventory_location',
      locationId,
      { locationId, version: updated.rows[0].version },
      `commerce:operation:${input.idempotencyKey}:event`,
    );
    await completeOperation(client, workspaceId, input.idempotencyKey, 'inventory_location', locationId, { locationId });
    return locationId;
    });
    return getInventoryLocation(workspaceId, resultId);
  } catch (error) {
    if (databaseCode(error) === '23505') {
      throw conflictError('An active inventory location with this code or default assignment already exists');
    }
    throw error;
  }
}

export async function listInventoryLevels(workspaceId: string, filters: ListInventoryLevelsQuery) {
  const values: unknown[] = [workspaceId];
  const where = ['il.workspace_id=$1'];
  if (filters.locationId) { values.push(filters.locationId); where.push(`il.location_id=$${values.length}`); }
  if (filters.productId) { values.push(filters.productId); where.push(`il.product_id=$${values.length}`); }
  if (filters.variantId) { values.push(filters.variantId); where.push(`il.variant_id=$${values.length}`); }
  if (filters.belowReorderPoint) where.push('(il.on_hand-il.reserved)<=il.reorder_point');
  const count = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM inventory_levels il WHERE ${where.join(' AND ')}`,
    values,
  );
  values.push(filters.limit, (filters.page - 1) * filters.limit);
  const levels = await query(
    `SELECT ${inventoryLevelSelect}
       FROM inventory_levels il
       JOIN inventory_locations loc ON loc.workspace_id=il.workspace_id AND loc.id=il.location_id
       JOIN products p ON p.workspace_id=il.workspace_id AND p.id=il.product_id
       LEFT JOIN product_variants pv ON pv.workspace_id=il.workspace_id AND pv.id=il.variant_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.name,COALESCE(pv.name,''),loc.name,il.id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  return {
    items: levels.rows,
    pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) },
  };
}

export async function getInventoryLevel(workspaceId: string, levelId: string, client?: PoolClient) {
  const result = await query(
    `SELECT ${inventoryLevelSelect}
       FROM inventory_levels il
       JOIN inventory_locations loc ON loc.workspace_id=il.workspace_id AND loc.id=il.location_id
       JOIN products p ON p.workspace_id=il.workspace_id AND p.id=il.product_id
       LEFT JOIN product_variants pv ON pv.workspace_id=il.workspace_id AND pv.id=il.variant_id
      WHERE il.workspace_id=$1 AND il.id=$2`,
    [workspaceId, levelId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function adjustInventory(
  workspaceId: string,
  actor: CommerceActor,
  input: AdjustInventoryInput,
) {
  const levelId = await withTransaction(async (client) => {
    const operation = await claimOperation(
      client,
      workspaceId,
      input.idempotencyKey,
      'inventory.adjust',
      requestHash(input),
      actor,
    );
    if (operation.replayed) {
      if (!operation.resourceId) throw idempotencyConflict();
      return operation.resourceId;
    }
    const prepared = await prepareOrderLines(client, workspaceId, 'XXX', [{
      productId: input.productId,
      variantId: input.variantId,
      inventoryLocationId: input.locationId,
      quantity: '1',
      unitPrice: '0',
      discount: '0',
      tax: '0',
      metadata: {},
    }]);
    if (!prepared[0]) throw notFoundError('Product not found');

    let level = (await query<LevelLockRow>(
      `SELECT id,on_hand AS "onHand",reserved,version,product_id AS "productId",
              variant_id AS "variantId",location_id AS "locationId"
         FROM inventory_levels
        WHERE workspace_id=$1 AND location_id=$2 AND product_id=$3
          AND variant_id IS NOT DISTINCT FROM $4::uuid
        FOR UPDATE`,
      [workspaceId, input.locationId, input.productId, input.variantId ?? null],
      client,
    )).rows[0];
    let wasCreated = false;
    if (!level) {
      if (input.expectedVersion !== 0) throw versionConflict('Inventory level');
      const inserted = await query<{ id: string }>(
        `INSERT INTO inventory_levels(workspace_id,location_id,product_id,variant_id,reorder_point)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [workspaceId, input.locationId, input.productId, input.variantId ?? null, input.reorderPoint ?? '0'],
        client,
      );
      wasCreated = Boolean(inserted.rows[0]);
      level = (await query<LevelLockRow>(
        `SELECT id,on_hand AS "onHand",reserved,version,product_id AS "productId",
                variant_id AS "variantId",location_id AS "locationId"
           FROM inventory_levels
          WHERE workspace_id=$1 AND location_id=$2 AND product_id=$3
            AND variant_id IS NOT DISTINCT FROM $4::uuid
          FOR UPDATE`,
        [workspaceId, input.locationId, input.productId, input.variantId ?? null],
        client,
      )).rows[0];
      if (!level) throw new Error('Inventory level insert did not return a row');
      if (!wasCreated) throw versionConflict('Inventory level');
    } else if (level.version !== input.expectedVersion) {
      throw versionConflict('Inventory level');
    }

    const updateValues: unknown[] = [workspaceId, level.id, input.delta];
    const reorderAssignment = input.reorderPoint === undefined ? '' : ',reorder_point=$4';
    if (input.reorderPoint !== undefined) updateValues.push(input.reorderPoint);
    const updated = await query<{ onHandBefore: string; onHand: string; reserved: string; version: number }>(
      `UPDATE inventory_levels
          SET on_hand=on_hand+$3::numeric${reorderAssignment},version=version+1
        WHERE workspace_id=$1 AND id=$2 AND on_hand+$3::numeric>=reserved AND on_hand+$3::numeric>=0
        RETURNING (on_hand-$3::numeric)::text AS "onHandBefore",on_hand::text AS "onHand",
                  reserved::text AS reserved,version`,
      updateValues,
      client,
    );
    const state = updated.rows[0];
    if (!state) {
      throw conflictError('Inventory adjustment would make stock negative or lower than reserved stock');
    }
    const beforeOnHand = state.onHandBefore;
    await appendMovement(client, {
      workspaceId,
      levelId: level.id,
      movementType: wasCreated ? 'INITIAL' : 'ADJUSTMENT',
      onHandDelta: input.delta,
      reservedDelta: '0',
      onHandBefore: beforeOnHand,
      onHandAfter: state.onHand,
      reservedBefore: state.reserved,
      reservedAfter: state.reserved,
      reason: input.reason,
      operationKey: input.idempotencyKey,
      metadata: input.metadata,
    }, actor);
    await appendAudit(
      client,
      workspaceId,
      actor,
      'inventory.adjusted',
      'inventory_level',
      level.id,
      { onHand: beforeOnHand, reserved: state.reserved, version: level.version },
      { onHand: state.onHand, reserved: state.reserved, version: state.version, reason: input.reason },
    );
    await emitEvent(
      client,
      workspaceId,
      actor,
      COMMERCE_EVENT_TYPES.INVENTORY_ADJUSTED,
      'inventory_level',
      level.id,
      { inventoryLevelId: level.id, delta: input.delta, onHand: state.onHand, available: decimalFromUnits(decimalUnits(state.onHand) - decimalUnits(state.reserved)) },
      `commerce:operation:${input.idempotencyKey}:event`,
    );
    await completeOperation(client, workspaceId, input.idempotencyKey, 'inventory_level', level.id, { inventoryLevelId: level.id });
    return level.id;
  });
  return getInventoryLevel(workspaceId, levelId);
}

export async function listInventoryMovements(workspaceId: string, filters: ListInventoryMovementsQuery) {
  const values: unknown[] = [workspaceId];
  const where = ['m.workspace_id=$1'];
  if (filters.levelId) { values.push(filters.levelId); where.push(`m.inventory_level_id=$${values.length}`); }
  if (filters.orderId) { values.push(filters.orderId); where.push(`m.order_id=$${values.length}`); }
  if (filters.movementType) { values.push(filters.movementType); where.push(`m.movement_type=$${values.length}`); }
  const count = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM inventory_movements m WHERE ${where.join(' AND ')}`,
    values,
  );
  values.push(filters.limit, (filters.page - 1) * filters.limit);
  const rows = await query(
    `SELECT m.id,m.workspace_id AS "workspaceId",m.inventory_level_id AS "inventoryLevelId",
            m.movement_type AS "movementType",m.on_hand_delta AS "onHandDelta",
            m.reserved_delta AS "reservedDelta",m.on_hand_before AS "onHandBefore",
            m.on_hand_after AS "onHandAfter",m.reserved_before AS "reservedBefore",
            m.reserved_after AS "reservedAfter",m.order_id AS "orderId",
            m.order_line_id AS "orderLineId",m.fulfillment_id AS "fulfillmentId",
            m.reason,m.operation_key AS "operationKey",m.actor_type AS "actorType",
            m.actor_ref AS "actorRef",m.metadata,m.created_at AS "createdAt"
       FROM inventory_movements m
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC,m.id DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  return {
    items: rows.rows,
    pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) },
  };
}

export async function listFulfillments(workspaceId: string, orderId: string) {
  const order = await query(`SELECT 1 FROM commerce_orders WHERE workspace_id=$1 AND id=$2`, [workspaceId, orderId]);
  if (!order.rows[0]) throw notFoundError('Order not found');
  const result = await query(
    `SELECT ${fulfillmentSelect}
       FROM commerce_fulfillments f
      WHERE f.workspace_id=$1 AND f.order_id=$2
      ORDER BY f.created_at DESC`,
    [workspaceId, orderId],
  );
  return result.rows;
}

export async function getFulfillment(
  workspaceId: string,
  orderId: string,
  fulfillmentId: string,
  client?: PoolClient,
) {
  const fulfillment = await query<CommerceFulfillmentRow>(
    `SELECT ${fulfillmentSelect}
       FROM commerce_fulfillments f
      WHERE f.workspace_id=$1 AND f.order_id=$2 AND f.id=$3`,
    [workspaceId, orderId, fulfillmentId],
    client,
  );
  if (!fulfillment.rows[0]) return null;
  const lines = await query(
    `SELECT fl.id,fl.order_line_id AS "orderLineId",fl.quantity,
            ol.product_id AS "productId",ol.variant_id AS "variantId",
            ol.sku_snapshot AS sku,ol.product_name_snapshot AS "productName"
       FROM commerce_fulfillment_lines fl
       JOIN commerce_order_lines ol
         ON ol.workspace_id=fl.workspace_id AND ol.id=fl.order_line_id AND ol.order_id=fl.order_id
      WHERE fl.workspace_id=$1 AND fl.order_id=$2 AND fl.fulfillment_id=$3
      ORDER BY ol.sort_order,fl.id`,
    [workspaceId, orderId, fulfillmentId],
    client,
  );
  return { fulfillment: fulfillment.rows[0], lines: lines.rows };
}

export async function createFulfillment(
  workspaceId: string,
  orderId: string,
  actor: CommerceActor,
  input: CreateFulfillmentInput,
) {
  const fulfillmentId = await withTransaction(async (client) => {
    const operation = await claimOperation(
      client,
      workspaceId,
      input.idempotencyKey,
      `fulfillment.create:${orderId}`,
      requestHash(input),
      actor,
    );
    if (operation.replayed) {
      if (!operation.resourceId) throw idempotencyConflict();
      return operation.resourceId;
    }
    const lockedOrder = await query<OrderLockRow>(
      `SELECT id,status,version,order_number AS "orderNumber",currency
         FROM commerce_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, orderId],
      client,
    );
    const order = lockedOrder.rows[0];
    if (!order) throw notFoundError('Order not found');
    if (order.version !== input.expectedOrderVersion) throw versionConflict('Order');
    if (!['CONFIRMED', 'PROCESSING', 'PARTIALLY_FULFILLED'].includes(order.status)) {
      throw conflictError(`Fulfillment cannot be created for an order in ${order.status}`);
    }

    const requestedIds = input.lines.map((line) => line.orderLineId);
    const orderLines = await query<OrderLineLockRow & { allocatedQuantity: string }>(
      `SELECT l.id,l.product_id AS "productId",l.variant_id AS "variantId",
              l.inventory_location_id AS "inventoryLocationId",l.quantity,
              l.reserved_quantity AS "reservedQuantity",l.fulfilled_quantity AS "fulfilledQuantity",
              COALESCE((
                SELECT SUM(fl.quantity)
                  FROM commerce_fulfillment_lines fl
                  JOIN commerce_fulfillments f
                    ON f.workspace_id=fl.workspace_id AND f.id=fl.fulfillment_id
                 WHERE fl.workspace_id=l.workspace_id AND fl.order_line_id=l.id
                   AND f.status IN ('DRAFT','PROCESSING')
              ),0)::text AS "allocatedQuantity"
         FROM commerce_order_lines l
        WHERE l.workspace_id=$1 AND l.order_id=$2 AND l.id=ANY($3::uuid[])
        ORDER BY l.id FOR UPDATE`,
      [workspaceId, orderId, requestedIds],
      client,
    );
    const lineMap = new Map(orderLines.rows.map((line) => [line.id, line]));
    for (const requested of input.lines) {
      const line = lineMap.get(requested.orderLineId);
      if (!line) throw notFoundError('Order line not found');
      const remaining = decimalUnits(line.quantity) - decimalUnits(line.fulfilledQuantity) - decimalUnits(line.allocatedQuantity);
      if (decimalUnits(requested.quantity) > remaining) {
        throw conflictError('Fulfillment quantity exceeds the unallocated order quantity');
      }
    }

    const sequence = await nextNumber(client, workspaceId, 'FULFILLMENT');
    const fulfillmentNumber = `FUL-${new Date().getUTCFullYear()}-${String(sequence).padStart(7, '0')}`;
    const inserted = await query<{ id: string }>(
      `INSERT INTO commerce_fulfillments(
         workspace_id,order_id,fulfillment_number,carrier,tracking_number,tracking_url,
         notes,metadata,created_by,updated_by,created_by_actor_type,created_by_actor_ref
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,$10,$11)
       RETURNING id`,
      [
        workspaceId,
        orderId,
        fulfillmentNumber,
        input.carrier ?? null,
        input.trackingNumber ?? null,
        input.trackingUrl ?? null,
        input.notes ?? null,
        JSON.stringify(input.metadata),
        userActorId(actor),
        actor.actorType,
        actor.actorRef ?? null,
      ],
      client,
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('Fulfillment insert did not return an id');
    for (const line of input.lines) {
      await query(
        `INSERT INTO commerce_fulfillment_lines(
           workspace_id,order_id,fulfillment_id,order_line_id,quantity
         ) VALUES($1,$2,$3,$4,$5)`,
        [workspaceId, orderId, id, line.orderLineId, line.quantity],
        client,
      );
    }
    const orderStatus = order.status === 'CONFIRMED' ? 'PROCESSING' : order.status;
    await query(
      `UPDATE commerce_orders SET status=$3,version=version+1,updated_by=$4
        WHERE workspace_id=$1 AND id=$2 AND version=$5`,
      [workspaceId, orderId, orderStatus, userActorId(actor), input.expectedOrderVersion],
      client,
    );
    await appendAudit(client, workspaceId, actor, 'fulfillment.created', 'commerce_fulfillment', id, null, {
      orderId,
      fulfillmentNumber,
      status: 'DRAFT',
      lineCount: input.lines.length,
    });
    await emitEvent(
      client,
      workspaceId,
      actor,
      COMMERCE_EVENT_TYPES.FULFILLMENT_CREATED,
      'commerce_fulfillment',
      id,
      { fulfillmentId: id, orderId, fulfillmentNumber, status: 'DRAFT' },
      `commerce:fulfillment:${id}:created`,
    );
    if (order.status === 'CONFIRMED') {
      await emitEvent(
        client,
        workspaceId,
        actor,
        COMMERCE_EVENT_TYPES.ORDER_PROCESSING,
        'commerce_order',
        orderId,
        { orderId, previousStatus: 'CONFIRMED', status: 'PROCESSING' },
        `commerce:fulfillment:${id}:order-processing`,
      );
    }
    await completeOperation(client, workspaceId, input.idempotencyKey, 'commerce_fulfillment', id, { fulfillmentId: id });
    return id;
  });
  return getFulfillment(workspaceId, orderId, fulfillmentId);
}

const fulfillmentTransitions: Readonly<Record<FulfillmentStatus, readonly FulfillmentStatus[]>> = {
  DRAFT: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

const fulfillmentTransitionEvents: Record<Exclude<FulfillmentStatus, 'DRAFT'>, string> = {
  PROCESSING: COMMERCE_EVENT_TYPES.FULFILLMENT_PROCESSING,
  SHIPPED: COMMERCE_EVENT_TYPES.FULFILLMENT_SHIPPED,
  DELIVERED: COMMERCE_EVENT_TYPES.FULFILLMENT_DELIVERED,
  CANCELLED: COMMERCE_EVENT_TYPES.FULFILLMENT_CANCELLED,
};

async function shipFulfillment(
  client: PoolClient,
  workspaceId: string,
  orderId: string,
  fulfillmentId: string,
  operationKey: string,
  actor: CommerceActor,
) {
  const lines = await query<OrderLineLockRow & { fulfillmentQuantity: string }>(
    `SELECT ol.id,ol.product_id AS "productId",ol.variant_id AS "variantId",
            ol.inventory_location_id AS "inventoryLocationId",ol.quantity,
            ol.reserved_quantity AS "reservedQuantity",ol.fulfilled_quantity AS "fulfilledQuantity",
            fl.quantity AS "fulfillmentQuantity"
       FROM commerce_fulfillment_lines fl
       JOIN commerce_order_lines ol
         ON ol.workspace_id=fl.workspace_id AND ol.id=fl.order_line_id AND ol.order_id=fl.order_id
      WHERE fl.workspace_id=$1 AND fl.order_id=$2 AND fl.fulfillment_id=$3
      ORDER BY ol.id FOR UPDATE OF ol`,
    [workspaceId, orderId, fulfillmentId],
    client,
  );
  for (const line of lines.rows) {
    if (decimalUnits(line.fulfilledQuantity) + decimalUnits(line.fulfillmentQuantity) > decimalUnits(line.quantity)) {
      throw conflictError('Fulfillment quantity exceeds the remaining order quantity');
    }
    if (line.inventoryLocationId) {
      if (decimalUnits(line.reservedQuantity) < decimalUnits(line.fulfillmentQuantity)) {
        throw conflictError('Fulfillment quantity exceeds reserved inventory');
      }
      const level = await getLevelForLine(client, workspaceId, line);
      if (!level) throw new Error('Reserved inventory level is missing');
      const changed = await query<{
        onHandBefore: string;
        onHandAfter: string;
        reservedBefore: string;
        reservedAfter: string;
      }>(
        `UPDATE inventory_levels
            SET on_hand=on_hand-$3::numeric,reserved=reserved-$3::numeric,version=version+1
          WHERE workspace_id=$1 AND id=$2 AND on_hand >= $3::numeric AND reserved >= $3::numeric
          RETURNING (on_hand+$3::numeric)::text AS "onHandBefore",on_hand::text AS "onHandAfter",
                    (reserved+$3::numeric)::text AS "reservedBefore",reserved::text AS "reservedAfter"`,
        [workspaceId, level.id, line.fulfillmentQuantity],
        client,
      );
      const state = changed.rows[0];
      if (!state) throw new Error('Reserved inventory state is inconsistent');
      await appendMovement(client, {
        workspaceId,
        levelId: level.id,
        movementType: 'FULFILLMENT',
        onHandDelta: `-${line.fulfillmentQuantity}`,
        reservedDelta: `-${line.fulfillmentQuantity}`,
        onHandBefore: state.onHandBefore,
        onHandAfter: state.onHandAfter,
        reservedBefore: state.reservedBefore,
        reservedAfter: state.reservedAfter,
        orderId,
        orderLineId: line.id,
        fulfillmentId,
        reason: 'Inventory shipped in fulfillment',
        operationKey: derivedOperationKey(operationKey, `ship:${line.id}`),
      }, actor);
      await emitEvent(
        client,
        workspaceId,
        actor,
        COMMERCE_EVENT_TYPES.INVENTORY_FULFILLED,
        'inventory_level',
        level.id,
        {
          inventoryLevelId: level.id,
          orderId,
          orderLineId: line.id,
          fulfillmentId,
          quantity: line.fulfillmentQuantity,
        },
        `commerce:operation:${operationKey}:ship:${line.id}`,
      );
    }
    const lineUpdate = line.inventoryLocationId
      ? `reserved_quantity=reserved_quantity-$4::numeric,fulfilled_quantity=fulfilled_quantity+$4::numeric`
      : `fulfilled_quantity=fulfilled_quantity+$4::numeric`;
    await query(
      `UPDATE commerce_order_lines SET ${lineUpdate},version=version+1
        WHERE workspace_id=$1 AND order_id=$2 AND id=$3`,
      [workspaceId, orderId, line.id, line.fulfillmentQuantity],
      client,
    );
  }
}

async function fulfillmentDerivedOrderStatus(client: PoolClient, workspaceId: string, orderId: string) {
  const result = await query<{ total: string; fulfilled: string }>(
    `SELECT COALESCE(SUM(quantity),0)::text AS total,
            COALESCE(SUM(fulfilled_quantity),0)::text AS fulfilled
       FROM commerce_order_lines
      WHERE workspace_id=$1 AND order_id=$2`,
    [workspaceId, orderId],
    client,
  );
  const totals = result.rows[0] ?? { total: '0', fulfilled: '0' };
  return decimalUnits(totals.total) > 0n && decimalUnits(totals.fulfilled) >= decimalUnits(totals.total)
    ? { orderStatus: 'FULFILLED' as const, fulfillmentStatus: 'FULFILLED' as const }
    : decimalUnits(totals.fulfilled) > 0n
      ? { orderStatus: 'PARTIALLY_FULFILLED' as const, fulfillmentStatus: 'PARTIALLY_FULFILLED' as const }
      : { orderStatus: 'PROCESSING' as const, fulfillmentStatus: 'UNFULFILLED' as const };
}

export async function transitionFulfillment(
  workspaceId: string,
  orderId: string,
  fulfillmentId: string,
  actor: CommerceActor,
  input: TransitionFulfillmentInput,
) {
  const resultId = await withTransaction(async (client) => {
    const operation = await claimOperation(
      client,
      workspaceId,
      input.idempotencyKey,
      `fulfillment.transition:${fulfillmentId}:${input.targetStatus}`,
      requestHash(input),
      actor,
    );
    if (operation.replayed) return operation.resourceId ?? fulfillmentId;
    const orderResult = await query<OrderLockRow>(
      `SELECT id,status,version,order_number AS "orderNumber",currency
         FROM commerce_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, orderId],
      client,
    );
    const order = orderResult.rows[0];
    if (!order) throw notFoundError('Order not found');
    if (order.version !== input.expectedOrderVersion) throw versionConflict('Order');
    const fulfillmentResult = await query<FulfillmentLockRow>(
      `SELECT id,status,version FROM commerce_fulfillments
        WHERE workspace_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE`,
      [workspaceId, orderId, fulfillmentId],
      client,
    );
    const fulfillment = fulfillmentResult.rows[0];
    if (!fulfillment) throw notFoundError('Fulfillment not found');
    if (fulfillment.version !== input.expectedVersion) throw versionConflict('Fulfillment');
    if (order.status === 'CANCELLED'
      && !(fulfillment.status === 'SHIPPED' && input.targetStatus === 'DELIVERED')) {
      throw conflictError('Cancelled orders cannot start or ship additional fulfillment work');
    }
    if (!fulfillmentTransitions[fulfillment.status].includes(input.targetStatus)) {
      throw conflictError(`Fulfillment cannot transition from ${fulfillment.status} to ${input.targetStatus}`);
    }
    if (input.targetStatus === 'SHIPPED') {
      await shipFulfillment(client, workspaceId, orderId, fulfillmentId, input.idempotencyKey, actor);
    }

    const values = [
      workspaceId,
      orderId,
      fulfillmentId,
      input.targetStatus,
      input.carrier ?? null,
      input.trackingNumber ?? null,
      input.trackingUrl ?? null,
      userActorId(actor),
      input.expectedVersion,
    ];
    const timestampAssignment = input.targetStatus === 'SHIPPED'
      ? ',shipped_at=NOW()'
      : input.targetStatus === 'DELIVERED'
        ? ',delivered_at=NOW()'
        : input.targetStatus === 'CANCELLED'
          ? ',cancelled_at=NOW()'
          : '';
    const updatedFulfillment = await query<{ version: number }>(
      `UPDATE commerce_fulfillments SET status=$4,
              carrier=COALESCE($5,carrier),tracking_number=COALESCE($6,tracking_number),
              tracking_url=COALESCE($7,tracking_url),updated_by=$8,version=version+1${timestampAssignment}
        WHERE workspace_id=$1 AND order_id=$2 AND id=$3 AND version=$9
        RETURNING version`,
      values,
      client,
    );
    if (!updatedFulfillment.rows[0]) throw versionConflict('Fulfillment');

    const derived = input.targetStatus === 'SHIPPED'
      ? await fulfillmentDerivedOrderStatus(client, workspaceId, orderId)
      : { orderStatus: order.status, fulfillmentStatus: null };
    const completedAssignment = derived.orderStatus === 'FULFILLED' ? ',completed_at=NOW()' : '';
    await query(
      `UPDATE commerce_orders SET status=$3,
              fulfillment_status=COALESCE($4,fulfillment_status),version=version+1,updated_by=$5${completedAssignment}
        WHERE workspace_id=$1 AND id=$2 AND version=$6`,
      [workspaceId, orderId, derived.orderStatus, derived.fulfillmentStatus, userActorId(actor), input.expectedOrderVersion],
      client,
    );
    await appendAudit(
      client,
      workspaceId,
      actor,
      `fulfillment.${input.targetStatus.toLowerCase()}`,
      'commerce_fulfillment',
      fulfillmentId,
      { status: fulfillment.status, version: fulfillment.version },
      { status: input.targetStatus, version: updatedFulfillment.rows[0].version, reason: input.reason ?? null },
    );
    await emitEvent(
      client,
      workspaceId,
      actor,
      fulfillmentTransitionEvents[input.targetStatus],
      'commerce_fulfillment',
      fulfillmentId,
      { fulfillmentId, orderId, previousStatus: fulfillment.status, status: input.targetStatus },
      `commerce:operation:${input.idempotencyKey}:event`,
    );
    if (input.targetStatus === 'SHIPPED') {
      const orderEvent = derived.orderStatus === 'FULFILLED'
        ? COMMERCE_EVENT_TYPES.ORDER_FULFILLED
        : COMMERCE_EVENT_TYPES.ORDER_PARTIALLY_FULFILLED;
      await emitEvent(
        client,
        workspaceId,
        actor,
        orderEvent,
        'commerce_order',
        orderId,
        { orderId, fulfillmentId, previousStatus: order.status, status: derived.orderStatus },
        `commerce:operation:${input.idempotencyKey}:order-event`,
      );
    }
    await completeOperation(client, workspaceId, input.idempotencyKey, 'commerce_fulfillment', fulfillmentId, {
      fulfillmentId,
      orderId,
      status: input.targetStatus,
    });
    return fulfillmentId;
  });
  return getFulfillment(workspaceId, orderId, resultId);
}
