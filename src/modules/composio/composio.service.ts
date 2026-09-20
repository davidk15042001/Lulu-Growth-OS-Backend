import { Composio } from '@composio/core';
import { env, hasComposio } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { hasAdminCapability } from '../admin/admin.authorization.js';
import { isBillingAdminUser } from '../billing/payg-billing.repo.js';
import { isCustomerRestrictedComposioToolkit } from '../integrations/integration-access.policy.js';
import { findMembership } from '../workspaces/workspace.repo.js';
import * as catalogRepo from './composio-catalog.repo.js';
import {
  chargeComposioUsage,
  finalizeComposioUsage,
  getComposioUsageSummary,
} from './composio-usage.repo.js';

let composio: Composio | undefined;

function client() {
  if (!hasComposio || !env.COMPOSIO_API_KEY) {
    throw new AppError(503, 'COMPOSIO_NOT_CONFIGURED', 'Composio is not configured on the server.');
  }
  composio ??= new Composio({ apiKey: env.COMPOSIO_API_KEY, allowTracking: false });
  return composio;
}

function scopedUserId(workspaceId: string, userId: string) {
  // Stable, tenant-scoped identity: a user can never reuse a connection from
  // another workspace accidentally.
  return `lulu:${workspaceId}:${userId}`;
}

export function getComposioUserId(workspaceId: string, userId: string) {
  return scopedUserId(workspaceId, userId);
}

export function normalizeComposioToolkit(value: string) {
  const toolkit = value.trim().toLowerCase();
  if (!toolkit || toolkit.length > 80 || !/^[a-z0-9][a-z0-9_-]*$/.test(toolkit)) {
    throw new AppError(422, 'COMPOSIO_TOOLKIT_INVALID', 'A valid Composio toolkit slug is required.');
  }
  return toolkit;
}

export function normalizeComposioToolSlug(value: string) {
  const slug = value.trim();
  if (!slug || slug.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(slug)) {
    throw new AppError(422, 'COMPOSIO_TOOL_INVALID', 'A valid Composio tool slug is required.');
  }
  return slug;
}

export function normalizeComposioTriggerSlug(value: string) {
  const slug = value.trim();
  if (!slug || slug.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(slug)) {
    throw new AppError(422, 'COMPOSIO_TRIGGER_INVALID', 'A valid Composio trigger slug is required.');
  }
  return slug;
}

export function normalizeComposioIdempotencyKey(value: string) {
  const key = value.trim();
  if (!key || key.length > 240 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new AppError(422, 'COMPOSIO_IDEMPOTENCY_KEY_INVALID', 'A valid Composio idempotency key is required.');
  }
  return key;
}

export function parseComposioUserId(value: string) {
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'lulu' || !parts[1] || !parts[2]) {
    throw new AppError(422, 'COMPOSIO_USER_INVALID', 'The Composio user identity is not a Lulu workspace identity.');
  }
  return { workspaceId: parts[1], userId: parts[2] };
}

export function isComposioConfigured() {
  return hasComposio;
}

async function canViewRestrictedToolkits(userId: string) {
  return hasAdminCapability(userId, 'providers.read');
}

async function canUseRestrictedToolkits(userId: string) {
  return hasAdminCapability(userId, 'providers.manage');
}

async function assertToolkitAllowed(toolkit: string, userId: string, action: 'view' | 'use') {
  if (!isCustomerRestrictedComposioToolkit(toolkit)) return;
  const allowed = action === 'view'
    ? await canViewRestrictedToolkits(userId)
    : await canUseRestrictedToolkits(userId);
  if (!allowed) {
    throw new AppError(403, 'COMPOSIO_TOOLKIT_ADMIN_ONLY', 'This Composio toolkit is managed by Lulu and is not available to workspace users.', { toolkit });
  }
}

async function assertToolkitAvailable(toolkit: string, userId: string, action: 'view' | 'use') {
  await assertToolkitAllowed(toolkit, userId, action);
  const adminCapability = action === 'view' ? 'providers.read' : 'providers.manage';
  if (await hasAdminCapability(userId, adminCapability)) return;
  if (!await catalogRepo.isCustomerAvailable(toolkit)) {
    throw new AppError(403, 'COMPOSIO_TOOLKIT_NOT_PUBLISHED', 'This Composio integration is not available for customer workspaces.', { toolkit });
  }
}

export async function createWorkspaceSession(input: { workspaceId: string; userId: string; toolkits?: string[] }) {
  const toolkits = (input.toolkits ?? []).map((toolkit) => toolkit.trim().toLowerCase()).filter(Boolean).slice(0, 50);
  for (const toolkit of toolkits) await assertToolkitAvailable(toolkit, input.userId, 'use');
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    ...(toolkits.length ? { toolkits: { enable: toolkits } } : {}),
    manageConnections: { enable: true },
  });
  return {
    sessionId: session.sessionId,
    userId: scopedUserId(input.workspaceId, input.userId),
    toolkits,
  };
}

export async function listWorkspaceToolkits(input: { workspaceId: string; userId: string; search?: string; cursor?: string }) {
  const canViewRestricted = await canViewRestrictedToolkits(input.userId);
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    manageConnections: { enable: true },
  });
  const result = await session.toolkits({
    limit: 100,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.search ? { search: input.search.trim().slice(0, 80) } : {}),
  });
  await catalogRepo.syncDiscoveredToolkits(result.items.map((toolkit) => ({
    toolkitSlug: toolkit.slug,
    displayName: toolkit.name,
    logoUrl: toolkit.logo ?? null,
  })));
  const catalog = await catalogRepo.listCatalogItems(result.items.map((toolkit) => toolkit.slug));
  const catalogBySlug = new Map(catalog.map((item) => [item.toolkitSlug, item]));
  return {
    items: result.items.filter((toolkit) => {
      if (canViewRestricted) return true;
      return !isCustomerRestrictedComposioToolkit(toolkit.slug) && Boolean(catalogBySlug.get(toolkit.slug)?.customerAvailable);
    }).map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      isNoAuth: toolkit.isNoAuth,
      ...(toolkit.logo ? { logo: toolkit.logo } : {}),
      connected: Boolean(toolkit.connection?.isActive),
      connectionStatus: toolkit.connection?.connectedAccount?.status ?? null,
      connectedAccountId: toolkit.connection?.connectedAccount?.id ?? null,
      customerAvailable: catalogBySlug.get(toolkit.slug)?.customerAvailable ?? false,
    })),
    nextCursor: result.cursor ?? null,
    totalPages: result.totalPages,
  };
}

export async function listAdminCatalog(input: { userId: string; search?: string; cursor?: string }) {
  const session = await client().sessions.create(`lulu:admin:${input.userId}`, {
    manageConnections: { enable: true },
  });
  const result = await session.toolkits({
    limit: 100,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.search ? { search: input.search.trim().slice(0, 80) } : {}),
  });
  await catalogRepo.syncDiscoveredToolkits(result.items.map((toolkit) => ({
    toolkitSlug: toolkit.slug,
    displayName: toolkit.name,
    logoUrl: toolkit.logo ?? null,
  })));
  const catalog = await catalogRepo.listCatalogItems(result.items.map((toolkit) => toolkit.slug));
  const catalogBySlug = new Map(catalog.map((item) => [item.toolkitSlug, item]));
  return {
    items: result.items.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      isNoAuth: toolkit.isNoAuth,
      ...(toolkit.logo ? { logo: toolkit.logo } : {}),
      customerAvailable: catalogBySlug.get(toolkit.slug)?.customerAvailable ?? false,
      certificationStatus: catalogBySlug.get(toolkit.slug)?.certificationStatus ?? 'DISCOVERED',
      publishedAt: catalogBySlug.get(toolkit.slug)?.publishedAt ?? null,
      customerRestricted: isCustomerRestrictedComposioToolkit(toolkit.slug),
    })),
    nextCursor: result.cursor ?? null,
    totalPages: result.totalPages,
  };
}

export async function listAdminTools(input: { toolkit: string; search?: string }) {
  const toolkit = normalizeComposioToolkit(input.toolkit);
  const search = input.search?.trim().slice(0, 120);
  const result = await client().tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: 500,
    ...(search ? { search } : {}),
  });
  return {
    items: result.map((tool) => ({
      slug: tool.slug,
      name: tool.name,
      description: tool.description?.trim().slice(0, 500) ?? null,
      toolkitSlug: tool.toolkit?.slug ?? toolkit,
      toolkitName: tool.toolkit?.name ?? toolkit,
      ...(tool.toolkit?.logo ? { logo: tool.toolkit.logo } : {}),
      isNoAuth: Boolean(tool.isNoAuth),
    })),
    total: result.length,
    truncated: result.length >= 500,
  };
}

export async function setAdminCatalogAvailability(input: {
  toolkit: string;
  displayName: string;
  logoUrl?: string | null;
  customerAvailable: boolean;
  adminUserId: string;
}) {
  const item = await catalogRepo.setCustomerAvailability({
    toolkitSlug: normalizeComposioToolkit(input.toolkit),
    displayName: input.displayName.trim(),
    ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
    customerAvailable: input.customerAvailable,
    adminUserId: input.adminUserId,
  });
  if (!item) throw new AppError(500, 'COMPOSIO_CATALOG_UPDATE_FAILED', 'The Composio catalog entry could not be updated.');
  return {
    slug: item.toolkitSlug,
    name: item.displayName,
    ...(item.logoUrl ? { logo: item.logoUrl } : {}),
    isNoAuth: false,
    customerAvailable: item.customerAvailable,
    certificationStatus: item.certificationStatus,
    publishedAt: item.publishedAt,
    customerRestricted: isCustomerRestrictedComposioToolkit(item.toolkitSlug),
  };
}

export async function listWorkspaceTools(input: { workspaceId: string; userId: string; toolkit: string; search?: string }) {
  const toolkit = normalizeComposioToolkit(input.toolkit);
  await assertToolkitAvailable(toolkit, input.userId, 'view');
  const search = input.search?.trim().slice(0, 120);
  const limit = 500;
  const result = await client().tools.getRawComposioTools({
    toolkits: [toolkit],
    limit,
    ...(search ? { search } : {}),
  });

  return {
    items: result.map((tool) => ({
      slug: tool.slug,
      name: tool.name,
      description: tool.description?.trim().slice(0, 500) ?? null,
      toolkitSlug: tool.toolkit?.slug ?? toolkit,
      toolkitName: tool.toolkit?.name ?? toolkit,
      ...(tool.toolkit?.logo ? { logo: tool.toolkit.logo } : {}),
      isNoAuth: Boolean(tool.isNoAuth),
    })),
    total: result.length,
    truncated: result.length >= limit,
  };
}

export async function authorizeWorkspaceToolkit(input: { workspaceId: string; userId: string; toolkit: string }) {
  const toolkit = normalizeComposioToolkit(input.toolkit);
  await assertToolkitAvailable(toolkit, input.userId, 'use');
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    toolkits: { enable: [toolkit] },
    manageConnections: { enable: true },
  });
  const connection = await session.authorize(toolkit);
  if (!connection.redirectUrl) {
    throw new AppError(502, 'COMPOSIO_CONNECT_LINK_MISSING', 'Composio did not return a connection link for this toolkit.');
  }
  return {
    sessionId: session.sessionId,
    toolkit,
    connectedAccountId: connection.id,
    redirectUrl: connection.redirectUrl,
  };
}

export async function executeWorkspaceTool(input: {
  workspaceId: string;
  userId: string;
  toolkit: string;
  toolSlug: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const toolkit = normalizeComposioToolkit(input.toolkit);
  const toolSlug = normalizeComposioToolSlug(input.toolSlug);
  const idempotencyKey = normalizeComposioIdempotencyKey(input.idempotencyKey);
  await assertToolkitAvailable(toolkit, input.userId, 'use');

  // Creating a session is not billable. The charge is committed immediately
  // before the remote tool call, so an accepted call can never run unfunded.
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    toolkits: { enable: [toolkit] },
    manageConnections: { enable: true },
  });
  const billingExempt = await isBillingAdminUser(input.userId);
  const charge = await chargeComposioUsage({
    workspaceId: input.workspaceId,
    userId: input.userId,
    billingExempt,
    usageType: 'TOOL_CALL',
    toolkitSlug: toolkit,
    toolSlug,
    idempotencyKey,
    metadata: { source: 'workspace_composio_execute' },
  });
  if (charge.idempotent) {
    if (!charge.usage) throw new Error('Composio usage idempotency row was not returned');
    throw new AppError(409, 'COMPOSIO_REQUEST_ALREADY_PROCESSED', 'This Composio idempotency key was already processed. Retry with a new key only for a new tool call.', {
      status: charge.usage.status,
      usageId: charge.usage.id,
    });
  }

  try {
    const result = await session.execute(toolSlug, input.arguments);
    if (!charge.idempotent && charge.usage) {
      try {
        await finalizeComposioUsage({
          workspaceId: input.workspaceId,
          usageId: charge.usage.id,
          status: result.error ? 'FAILED' : 'SUCCEEDED',
          providerLogId: result.logId || null,
          ...(result.error ? { errorCode: 'COMPOSIO_TOOL_ERROR' } : {}),
        });
      } catch {
        throw new AppError(503, 'COMPOSIO_BILLING_AMBIGUOUS', 'The Composio tool result was received, but billing finalization is pending reconciliation.');
      }
    }
    return {
      data: result.data,
      error: result.error,
      logId: result.logId,
      billing: { charged: charge.charged, waived: charge.waived, amountCny: charge.amountCny, currency: 'CNY' as const, usageType: 'TOOL_CALL' as const },
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'COMPOSIO_BILLING_AMBIGUOUS') throw error;
    if (!charge.idempotent && charge.usage) {
      try {
        await finalizeComposioUsage({
          workspaceId: input.workspaceId,
          usageId: charge.usage.id,
          status: 'FAILED',
          errorCode: error instanceof AppError ? error.code : 'COMPOSIO_TOOL_EXECUTION_FAILED',
        });
      } catch {
        throw new AppError(503, 'COMPOSIO_BILLING_AMBIGUOUS', 'The Composio tool call outcome is ambiguous and requires reconciliation.');
      }
    }
    throw error;
  }
}

export async function createWorkspaceTrigger(input: {
  workspaceId: string;
  userId: string;
  triggerSlug: string;
  toolkit?: string;
  triggerConfig?: Record<string, unknown>;
  connectedAccountId?: string;
}) {
  const triggerSlug = normalizeComposioTriggerSlug(input.triggerSlug);
  const triggerToolkit = input.toolkit?.trim() || input.triggerSlug.split(/[_./-]/)[0] || '';
  await assertToolkitAvailable(triggerToolkit, input.userId, 'use');
  const webhookUrl = env.COMPOSIO_WEBHOOK_URL
    ?? (env.OAUTH_CALLBACK_BASE_URL ? `${env.OAUTH_CALLBACK_BASE_URL.replace(/\/$/, '')}/composio/webhook` : undefined);
  if (!env.COMPOSIO_WEBHOOK_SECRET || !webhookUrl) {
    throw new AppError(503, 'COMPOSIO_WEBHOOK_NOT_CONFIGURED', 'Composio triggers require a public webhook URL and COMPOSIO_WEBHOOK_SECRET.');
  }
  const composioClient = client();
  await composioClient.triggers.setWebhookSubscription({
    webhookUrl,
    version: 'V3',
  });
  const trigger = await composioClient.triggers.create(scopedUserId(input.workspaceId, input.userId), triggerSlug, {
    ...(input.triggerConfig ? { triggerConfig: input.triggerConfig } : {}),
    ...(input.connectedAccountId ? { connectedAccountId: input.connectedAccountId } : {}),
  });
  return { triggerId: trigger.triggerId, triggerSlug, webhookConfigured: true };
}

export async function handleComposioWebhook(input: { rawBody: string; headers: Record<string, string | string[] | undefined> }) {
  if (!env.COMPOSIO_WEBHOOK_SECRET) {
    throw new AppError(503, 'COMPOSIO_WEBHOOK_NOT_CONFIGURED', 'Composio webhook verification is not configured.');
  }
  const parsed = await client().triggers.parse(
    { body: input.rawBody, headers: input.headers },
    { verifySecret: env.COMPOSIO_WEBHOOK_SECRET },
  );
  const event = parsed.payload;
  const identity = parseComposioUserId(event.userId);
  if (!await findMembership(identity.workspaceId, identity.userId)) {
    throw new AppError(404, 'COMPOSIO_WORKSPACE_NOT_FOUND', 'The Composio trigger is not attached to an active Lulu workspace member.');
  }
  const toolkitSlug = normalizeComposioToolkit(event.toolkitSlug);
  const triggerSlug = normalizeComposioTriggerSlug(event.triggerSlug);
  const eventId = normalizeComposioIdempotencyKey(event.id);
  const charge = await chargeComposioUsage({
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    billingExempt: await isBillingAdminUser(identity.userId),
    usageType: 'TRIGGER',
    toolkitSlug,
    triggerSlug,
    providerEventId: eventId,
    idempotencyKey: eventId,
    metadata: { source: 'composio_webhook', eventUuid: event.uuid },
  });
  if (!charge.idempotent && charge.usage) {
    await finalizeComposioUsage({
      workspaceId: identity.workspaceId,
      usageId: charge.usage.id,
      status: 'SUCCEEDED',
      providerLogId: event.uuid,
    });
  }
  return {
    accepted: true,
    duplicate: charge.idempotent,
    eventId,
    workspaceId: identity.workspaceId,
    billing: { charged: charge.charged, waived: charge.waived, amountCny: charge.amountCny, currency: 'CNY' as const, usageType: 'TRIGGER' as const },
  };
}

export { getComposioUsageSummary };
