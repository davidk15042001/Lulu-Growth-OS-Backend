import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/commerce_tests_only';
process.env.JWT_SECRET = 'commerce-tests-only-secret-at-least-32-characters';

const { pool } = await import('../src/db/pool.js');
const commerce = await import('../src/modules/commerce/commerce.service.js');
const validators = await import('../src/modules/commerce/commerce.validator.js');
const commercialDocuments = await import('../src/modules/commercial-documents/commercial-documents.repo.js');
const commercialValidators = await import('../src/modules/commercial-documents/commercial-documents.validator.js');
const { AppError } = await import('../src/utils/app-error.js');
const db = new PGlite();

const actor = (userId: string) => ({ actorType: 'USER' as const, actorRef: userId });

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

async function fixture(name: string, stock = '10') {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@example.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES($1,$2) RETURNING id`,
    [name, userId],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,
    [workspaceId, userId],
  );
  const productId = (await db.query<{ id: string }>(
    `INSERT INTO products(
       workspace_id,status,product_type,sku,name,default_currency,default_price,pricing_type,created_by
     ) VALUES($1,'ACTIVE','PHYSICAL_PRODUCT',$2,$3,'CNY',25,'FIXED',$4) RETURNING id`,
    [workspaceId, `SKU-${crypto.randomUUID()}`, `${name} Product`, userId],
  )).rows[0]!.id;
  const location = await commerce.createInventoryLocation(workspaceId, actor(userId), validators.createInventoryLocationSchema.parse({
    idempotencyKey: `${name}:location`,
    code: 'MAIN',
    name: 'Main warehouse',
    isDefault: true,
  })) as { id: string; version: number };
  const level = await commerce.adjustInventory(workspaceId, actor(userId), validators.adjustInventorySchema.parse({
    idempotencyKey: `${name}:initial-stock`,
    locationId: location.id,
    productId,
    delta: stock,
    expectedVersion: 0,
    reason: 'Opening inventory count',
  })) as { id: string; version: number; onHand: string; reserved: string; available: string };
  return { userId, workspaceId, productId, location, level };
}

function createOrderInput(
  operationKey: string,
  productId: string,
  locationId: string,
  quantity: string,
) {
  return validators.createOrderSchema.parse({
    idempotencyKey: operationKey,
    currency: 'CNY',
    lines: [{ productId, inventoryLocationId: locationId, quantity }],
  });
}

describe('canonical commerce orders and inventory', () => {
  it('reserves atomically, rejects overselling, and releases outstanding stock on cancellation', async () => {
    const context = await fixture('Commerce reserve', '5');
    const created = await commerce.createOrder(
      context.workspaceId,
      actor(context.userId),
      createOrderInput('reserve:order-one', context.productId, context.location.id, '4'),
    ) as { order: { id: string; version: number; status: string } };

    const placed = await commerce.transitionOrder(context.workspaceId, created.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
      idempotencyKey: 'reserve:order-one:placed',
      expectedVersion: created.order.version,
      targetStatus: 'PLACED',
    })) as { order: { version: number; status: string } };
    const confirmed = await commerce.transitionOrder(context.workspaceId, created.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
      idempotencyKey: 'reserve:order-one:confirmed',
      expectedVersion: placed.order.version,
      targetStatus: 'CONFIRMED',
    })) as { order: { version: number; status: string } };
    assert.equal(confirmed.order.status, 'CONFIRMED');

    const reserved = await commerce.getInventoryLevel(context.workspaceId, context.level.id) as {
      onHand: string;
      reserved: string;
      available: string;
    };
    assert.equal(Number(reserved.onHand), 5);
    assert.equal(Number(reserved.reserved), 4);
    assert.equal(Number(reserved.available), 1);

    const second = await commerce.createOrder(
      context.workspaceId,
      actor(context.userId),
      createOrderInput('reserve:order-two', context.productId, context.location.id, '2'),
    ) as { order: { id: string; version: number } };
    const secondPlaced = await commerce.transitionOrder(context.workspaceId, second.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
      idempotencyKey: 'reserve:order-two:placed',
      expectedVersion: second.order.version,
      targetStatus: 'PLACED',
    })) as { order: { version: number } };
    await assert.rejects(
      () => commerce.transitionOrder(context.workspaceId, second.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
        idempotencyKey: 'reserve:order-two:confirmed',
        expectedVersion: secondPlaced.order.version,
        targetStatus: 'CONFIRMED',
      })),
      (error: unknown) => error instanceof AppError && error.code === 'INSUFFICIENT_STOCK',
    );

    const cancelled = await commerce.transitionOrder(context.workspaceId, created.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
      idempotencyKey: 'reserve:order-one:cancelled',
      expectedVersion: confirmed.order.version,
      targetStatus: 'CANCELLED',
      reason: 'Customer cancellation',
    })) as { order: { status: string } };
    assert.equal(cancelled.order.status, 'CANCELLED');
    const released = await commerce.getInventoryLevel(context.workspaceId, context.level.id) as { onHand: string; reserved: string };
    assert.equal(Number(released.onHand), 5);
    assert.equal(Number(released.reserved), 0);
  });

  it('ships partial fulfillments against reservations and derives the real order state', async () => {
    const context = await fixture('Commerce fulfillment', '10');
    const created = await commerce.createOrder(
      context.workspaceId,
      actor(context.userId),
      createOrderInput('fulfill:order', context.productId, context.location.id, '5'),
    ) as { order: { id: string; version: number }; lines: Array<{ id: string }> };
    const placed = await commerce.transitionOrder(context.workspaceId, created.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
      idempotencyKey: 'fulfill:placed', expectedVersion: created.order.version, targetStatus: 'PLACED',
    })) as { order: { version: number } };
    const confirmed = await commerce.transitionOrder(context.workspaceId, created.order.id, actor(context.userId), validators.transitionOrderSchema.parse({
      idempotencyKey: 'fulfill:confirmed', expectedVersion: placed.order.version, targetStatus: 'CONFIRMED',
    })) as { order: { version: number } };

    const first = await commerce.createFulfillment(context.workspaceId, created.order.id, actor(context.userId), validators.createFulfillmentSchema.parse({
      idempotencyKey: 'fulfill:first:create',
      expectedOrderVersion: confirmed.order.version,
      lines: [{ orderLineId: created.lines[0]!.id, quantity: '3' }],
    })) as { fulfillment: { id: string; version: number } };
    let order = await commerce.getOrder(context.workspaceId, created.order.id) as { order: { version: number; status: string } };
    const processing = await commerce.transitionFulfillment(context.workspaceId, created.order.id, first.fulfillment.id, actor(context.userId), validators.transitionFulfillmentSchema.parse({
      idempotencyKey: 'fulfill:first:processing',
      expectedVersion: first.fulfillment.version,
      expectedOrderVersion: order.order.version,
      targetStatus: 'PROCESSING',
    })) as { fulfillment: { version: number } };
    order = await commerce.getOrder(context.workspaceId, created.order.id) as { order: { version: number; status: string } };
    const shipped = await commerce.transitionFulfillment(context.workspaceId, created.order.id, first.fulfillment.id, actor(context.userId), validators.transitionFulfillmentSchema.parse({
      idempotencyKey: 'fulfill:first:shipped',
      expectedVersion: processing.fulfillment.version,
      expectedOrderVersion: order.order.version,
      targetStatus: 'SHIPPED',
      carrier: 'Test carrier',
      trackingNumber: 'TRACK-1',
    })) as { fulfillment: { version: number; status: string } };
    assert.equal(shipped.fulfillment.status, 'SHIPPED');
    order = await commerce.getOrder(context.workspaceId, created.order.id) as { order: { version: number; status: string } };
    assert.equal(order.order.status, 'PARTIALLY_FULFILLED');
    let level = await commerce.getInventoryLevel(context.workspaceId, context.level.id) as { onHand: string; reserved: string };
    assert.equal(Number(level.onHand), 7);
    assert.equal(Number(level.reserved), 2);

    const second = await commerce.createFulfillment(context.workspaceId, created.order.id, actor(context.userId), validators.createFulfillmentSchema.parse({
      idempotencyKey: 'fulfill:second:create',
      expectedOrderVersion: order.order.version,
      lines: [{ orderLineId: created.lines[0]!.id, quantity: '2' }],
    })) as { fulfillment: { id: string; version: number } };
    order = await commerce.getOrder(context.workspaceId, created.order.id) as { order: { version: number; status: string } };
    const secondProcessing = await commerce.transitionFulfillment(context.workspaceId, created.order.id, second.fulfillment.id, actor(context.userId), validators.transitionFulfillmentSchema.parse({
      idempotencyKey: 'fulfill:second:processing',
      expectedVersion: second.fulfillment.version,
      expectedOrderVersion: order.order.version,
      targetStatus: 'PROCESSING',
    })) as { fulfillment: { version: number } };
    order = await commerce.getOrder(context.workspaceId, created.order.id) as { order: { version: number; status: string } };
    await commerce.transitionFulfillment(context.workspaceId, created.order.id, second.fulfillment.id, actor(context.userId), validators.transitionFulfillmentSchema.parse({
      idempotencyKey: 'fulfill:second:shipped',
      expectedVersion: secondProcessing.fulfillment.version,
      expectedOrderVersion: order.order.version,
      targetStatus: 'SHIPPED',
    }));
    const complete = await commerce.getOrder(context.workspaceId, created.order.id) as { order: { status: string; fulfillmentStatus: string } };
    assert.equal(complete.order.status, 'FULFILLED');
    assert.equal(complete.order.fulfillmentStatus, 'FULFILLED');
    level = await commerce.getInventoryLevel(context.workspaceId, context.level.id) as { onHand: string; reserved: string };
    assert.equal(Number(level.onHand), 5);
    assert.equal(Number(level.reserved), 0);
  });

  it('deduplicates mutations, enforces optimistic versions and isolates tenants', async () => {
    const context = await fixture('Commerce safety', '3');
    const input = createOrderInput('safety:create', context.productId, context.location.id, '1');
    const first = await commerce.createOrder(context.workspaceId, actor(context.userId), input) as { order: { id: string; version: number } };
    const replay = await commerce.createOrder(context.workspaceId, actor(context.userId), input) as { order: { id: string } };
    assert.equal(replay.order.id, first.order.id);
    await assert.rejects(
      () => commerce.createOrder(context.workspaceId, actor(context.userId), createOrderInput('safety:create', context.productId, context.location.id, '2')),
      (error: unknown) => error instanceof AppError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      () => commerce.updateOrder(context.workspaceId, first.order.id, actor(context.userId), validators.updateOrderSchema.parse({
        idempotencyKey: 'safety:bad-version',
        expectedVersion: first.order.version + 1,
        notes: 'Stale update',
      })),
      (error: unknown) => error instanceof AppError && error.code === 'VERSION_CONFLICT',
    );

    const other = await fixture('Commerce other tenant', '1');
    await assert.rejects(
      () => commerce.getOrder(other.workspaceId, first.order.id),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
    );

    const replayedLevel = await commerce.adjustInventory(context.workspaceId, actor(context.userId), validators.adjustInventorySchema.parse({
      idempotencyKey: 'safety:add-stock',
      locationId: context.location.id,
      productId: context.productId,
      delta: '2',
      expectedVersion: context.level.version,
      reason: 'Count correction',
    })) as { id: string; onHand: string; version: number };
    const replayedAgain = await commerce.adjustInventory(context.workspaceId, actor(context.userId), validators.adjustInventorySchema.parse({
      idempotencyKey: 'safety:add-stock',
      locationId: context.location.id,
      productId: context.productId,
      delta: '2',
      expectedVersion: context.level.version,
      reason: 'Count correction',
    })) as { id: string; onHand: string };
    assert.equal(replayedAgain.id, replayedLevel.id);
    assert.equal(Number(replayedAgain.onHand), 5);
  });

  it('keeps inventory movements append-only', async () => {
    const context = await fixture('Commerce immutable', '4');
    const movement = await db.query<{ id: string }>(
      `SELECT id FROM inventory_movements WHERE workspace_id=$1 LIMIT 1`,
      [context.workspaceId],
    );
    assert.ok(movement.rows[0]?.id);
    await assert.rejects(
      () => db.query(`UPDATE inventory_movements SET reason='tampered' WHERE id=$1`, [movement.rows[0]!.id]),
      /append-only/,
    );
    await assert.rejects(
      () => db.query(`DELETE FROM inventory_movements WHERE id=$1`, [movement.rows[0]!.id]),
      /append-only/,
    );
  });

  it('uses the same canonical service for autonomous actors without forging a human owner', async () => {
    const context = await fixture('Commerce autonomous', '2');
    const created = await commerce.createOrder(
      context.workspaceId,
      { actorType: 'AI_AGENT', actorRef: 'system:order-manager', correlationId: crypto.randomUUID() },
      createOrderInput('autonomous:create', context.productId, context.location.id, '1'),
    ) as { order: { id: string; createdByActorType: string; createdByActorRef: string } };
    assert.equal(created.order.createdByActorType, 'AI_AGENT');
    assert.equal(created.order.createdByActorRef, 'system:order-manager');
    const stored = await db.query<{ created_by: string | null; created_by_actor_type: string }>(
      `SELECT created_by,created_by_actor_type FROM commerce_orders WHERE workspace_id=$1 AND id=$2`,
      [context.workspaceId, created.order.id],
    );
    assert.equal(stored.rows[0]?.created_by, null);
    assert.equal(stored.rows[0]?.created_by_actor_type, 'AI_AGENT');
  });

  it('links invoices to the canonical order without duplicating the legacy order record', async () => {
    const context = await fixture('Commerce invoice', '2');
    await db.query(`INSERT INTO resource_types(key,domain,label)
      VALUES('ecommerce_customers','ecommerce','Commerce customers') ON CONFLICT DO NOTHING`);
    const customerId = (await db.query<{ id: string }>(
      `INSERT INTO workspace_records(workspace_id,resource_type,name,created_by)
       VALUES($1,'ecommerce_customers','Invoice customer',$2) RETURNING id`,
      [context.workspaceId, context.userId],
    )).rows[0]!.id;
    const order = await commerce.createOrder(
      context.workspaceId,
      actor(context.userId),
      validators.createOrderSchema.parse({
        idempotencyKey: 'invoice:canonical-order',
        customerRecordId: customerId,
        currency: 'CNY',
        lines: [{ productId: context.productId, inventoryLocationId: context.location.id, quantity: '1' }],
      }),
    ) as { order: { id: string; currency: string }; lines: Array<Record<string, unknown>> };
    const input = commercialValidators.createInvoiceSchema.parse({
      operationKey: 'invoice:create:canonical-order:first',
      commerceOrderId: order.order.id,
      customerRecordId: customerId,
      currency: order.order.currency,
      source: 'api',
      creationMode: 'AUTOMATIC',
      lines: order.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        productName: line.productName,
        description: line.description,
        quantity: line.quantity,
        quantityUnit: line.quantityUnit,
        unitPrice: line.unitPrice,
        discount: line.discount,
        tax: line.tax,
      })),
    });
    const sourceActionRecordId = crypto.randomUUID();
    const first = await commercialDocuments.createInvoice(context.workspaceId, context.userId, input, {
      actorType: 'AI_AGENT',
      actorRef: sourceActionRecordId,
      sourceActionRecordId,
      correlationId: 'agent-run:test-invoice',
      causationId: 'agent-command:test-invoice',
    }) as {
      invoice: { id: string; commerceOrderId: string; orderRecordId: string | null };
      idempotent: boolean;
    };
    // A separately keyed retry for the same order is serialized on the order
    // row and safely attaches to the first operation instead of duplicating it.
    const orderReplay = await commercialDocuments.createInvoice(context.workspaceId, context.userId, {
      ...input,
      operationKey: 'invoice:create:canonical-order:concurrent-alias',
    }) as { invoice: { id: string }; idempotent: boolean };
    const replay = await commercialDocuments.createInvoice(context.workspaceId, context.userId, input) as { invoice: { id: string }; idempotent: boolean };
    assert.equal(first.invoice.commerceOrderId, order.order.id);
    assert.equal(first.invoice.orderRecordId, null);
    assert.equal(orderReplay.invoice.id, first.invoice.id);
    assert.equal(first.idempotent, false);
    assert.equal(orderReplay.idempotent, true);
    assert.equal(replay.invoice.id, first.invoice.id);
    assert.equal(replay.idempotent, true);
    const event = (await db.query<{ payload: Record<string, unknown>; metadata: Record<string, unknown> }>(
      `SELECT payload,metadata FROM domain_events
        WHERE workspace_id=$1 AND aggregate_type='invoice' AND aggregate_id=$2
          AND event_type='invoice.created'`,
      [context.workspaceId, first.invoice.id],
    )).rows[0]!;
    assert.equal(event.metadata.actorType, 'AI_AGENT');
    assert.equal(event.metadata.actorRef, sourceActionRecordId);
    assert.equal(event.metadata.sourceActionRecordId, sourceActionRecordId);
    assert.equal(event.payload.creationMode, 'AUTOMATIC');
    const operations = await db.query<{ status: string; requestHash: string; documentId: string }>(
      `SELECT status,request_hash AS "requestHash",document_id AS "documentId"
         FROM commercial_document_operations WHERE workspace_id=$1 AND document_id=$2`,
      [context.workspaceId, first.invoice.id],
    );
    assert.equal(operations.rows.length, 2);
    assert.ok(operations.rows.every((operation) => operation.status === 'COMPLETED' && operation.requestHash.length === 64));
    await assert.rejects(
      () => commercialDocuments.createInvoice(context.workspaceId, context.userId, {
        ...input,
        lines: input.lines.map((line, index) => index === 0 ? { ...line, unitPrice: Number(line.unitPrice) + 1 } : line),
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && (error as { code?: unknown }).code === 'INVOICE_IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => commercialValidators.createInvoiceSchema.parse({ ...input, orderRecordId: crypto.randomUUID() }),
      /either the canonical commerce order or the legacy order record/i,
    );
  });

  it('allows an intentional tenant teardown while keeping ordinary movement deletion blocked', async () => {
    const context = await fixture('Commerce teardown', '1');
    await db.query(`DELETE FROM workspaces WHERE id=$1`, [context.workspaceId]);
    const remaining = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE workspace_id=$1`,
      [context.workspaceId],
    );
    assert.equal(remaining.rows[0]?.count, '0');
  });
});
