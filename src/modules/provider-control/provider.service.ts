import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { resolveWorkspaceEntitlements } from '../entitlements/entitlement.service.js';
import * as repo from './provider.repo.js';
import { PROVIDER_CATALOG, canonicalProviderKey, getProviderAdapter, getProviderCatalogEntry, isProviderRegistered, providerError } from './provider-registry.js';
import type { ProviderCapabilityStatus, ProviderConnectionStatus, ProviderHealthStatus, ProviderMode } from './provider.types.js';
import { verifyWebhookSignature as verifyUnifyPortWebhookSignature } from './unifyport.client.js';

export function listProviderCatalog() {
  return repo.listProviderCatalog();
}

const PROVIDER_ENTITLEMENTS: Record<string, string> = {
  google_ads: 'advertising.google',
  meta: 'advertising.meta',
  lulu_managed_website: 'website.managed_mode',
  wordpress: 'website.enabled',
  webflow: 'website.enabled',
  gmail: 'email.enabled',
  microsoft_email: 'email.enabled',
  imap_smtp: 'email.enabled',
  google_calendar: 'calendar.enabled',
  microsoft_calendar: 'calendar.enabled',
  whatsapp: 'whatsapp.enabled',
};

async function applyEffectiveCapabilityPolicy(workspaceId: string, connections: repo.ProviderConnection[]) {
  const entitlements = await resolveWorkspaceEntitlements(workspaceId);
  return connections.map((connection) => ({
    ...connection,
    capabilities: connection.capabilities.map((capability) => {
      if (connection.status === 'DISCONNECTED' || connection.status === 'UNAVAILABLE') {
        return { ...capability, status: 'UNAVAILABLE' as const, source: 'LULU_POLICY', lastError: 'The provider connection is not connected.' };
      }
      if (connection.status === 'AUTHORIZATION_REQUIRED' || connection.status === 'EXPIRED') {
        return { ...capability, status: 'AUTHORIZATION_REQUIRED' as const, source: 'LULU_POLICY', lastError: 'Provider authorization is required.' };
      }
      if (connection.status === 'PROVIDER_REVIEW') {
        return { ...capability, status: 'PROVIDER_REVIEW' as const, source: 'LULU_POLICY', lastError: 'Provider verification is required.' };
      }
      if (connection.scopeType !== 'WORKSPACE' && connection.sharedGrantedCapabilities && !connection.sharedGrantedCapabilities.includes(capability.capabilityKey)) {
        return { ...capability, status: 'BLOCKED' as const, source: 'LULU_POLICY', lastError: 'This shared provider capability has not been granted to the workspace.' };
      }
      const entitlementKey = PROVIDER_ENTITLEMENTS[connection.providerKey];
      if (!entitlementKey || entitlements[entitlementKey as keyof typeof entitlements]?.enabled !== false) return capability;
      if (['ERROR', 'AUTHORIZATION_REQUIRED', 'UNAVAILABLE'].includes(capability.status)) return capability;
      return { ...capability, status: 'PLAN_REQUIRED' as const, source: 'ENTITLEMENT', lastError: `The workspace entitlement ${entitlementKey} is not enabled.` };
    }),
  }));
}

export async function listWorkspaceProviders(workspaceId: string) {
  return applyEffectiveCapabilityPolicy(workspaceId, await repo.listProviderConnections(workspaceId));
}

export function listAdminProviders() {
  return repo.listAdminProviderConnections();
}

export async function getWorkspaceProvider(workspaceId: string, connectionId: string) {
  const connection = await repo.getProviderConnection(workspaceId, connectionId);
  if (!connection) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  return (await applyEffectiveCapabilityPolicy(workspaceId, [connection]))[0];
}

function connectionContext(row: Record<string, unknown>) {
  return {
    connectionId: String(row.id),
    providerKey: String(row.providerKey),
    externalAccountId: row.externalAccountId == null ? null : String(row.externalAccountId),
    grantedScopes: Array.isArray(row.grantedScopesRaw ?? row.grantedScopes) ? ((row.grantedScopesRaw ?? row.grantedScopes) as unknown[]).map(String) : [],
    metadata: ((row.metadataRaw ?? {}) as Record<string, unknown>),
  };
}

function evaluateStoredHealth(row: Record<string, unknown>): { status: ProviderHealthStatus; reason: string } {
  const status = String(row.status);
  if (status === 'DISCONNECTED') return { status: 'DISCONNECTED', reason: 'The provider connection is disconnected.' };
  if (status === 'AUTHORIZATION_REQUIRED' || status === 'EXPIRED') return { status: 'AUTHORIZATION_REQUIRED', reason: 'Provider authorization is required before Lulu can operate this connection.' };
  if (status === 'PROVIDER_REVIEW') return { status: 'PROVIDER_REVIEW', reason: 'The provider requires an approved or live capability verification before Lulu can operate this connection.' };
  if (status === 'UNAVAILABLE') return { status: 'DISCONNECTED', reason: 'The provider connection is currently unavailable.' };
  if (status === 'SUSPENDED') return { status: 'DEGRADED', reason: 'The connection has been suspended by policy or operations.' };
  if (status === 'ERROR') return { status: 'ERROR', reason: String(row.lastError ?? 'The last provider operation failed.') };
  if (row.rateLimitResetAt && new Date(String(row.rateLimitResetAt)).getTime() > Date.now()) return { status: 'RATE_LIMITED', reason: 'The provider returned a rate limit; retry after the recorded time.' };
  const consecutiveFailures = Number(row.consecutiveFailures ?? 0);
  if (consecutiveFailures >= 5) return { status: 'ERROR', reason: 'The provider has failed repeatedly and requires operational attention.' };
  if (consecutiveFailures >= 2) return { status: 'DEGRADED', reason: 'The provider has experienced repeated recent failures.' };
  if (row.lastSuccessAt) return { status: 'HEALTHY', reason: 'A provider operation completed successfully.' };
  if (row.lastWebhookAt) return { status: 'HEALTHY', reason: 'A verified provider webhook was received recently.' };
  return { status: 'UNKNOWN', reason: 'A provider connection exists, but no successful provider API probe has been recorded.' };
}

export async function verifyWorkspaceProvider(workspaceId: string, connectionId: string, actorId: string) {
  await assertWorkspaceCapability({ workspaceId, userId: actorId, capability: 'providers.manage' });
  const row = await repo.getProviderConnectionInternal(connectionId);
  if (!row || String(row.workspaceId) !== workspaceId) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  const adapter = getProviderAdapter(String(row.providerKey));
  const result = await adapter.verifyConnection(connectionContext(row));
  const health = result.healthStatus;
  const status = result.status as ProviderConnectionStatus;
  await repo.updateConnectionVerification({ workspaceId, connectionId, status, authorizationState: result.authorizationState, healthStatus: health, healthReason: result.reason, lastVerifiedAt: new Date(), lastSuccessAt: result.lastSuccessAt ? new Date(result.lastSuccessAt) : null, lastError: result.verified ? null : result.reason });
  const definitions = await repo.listCapabilityDefinitions(String(row.providerKey));
  for (const definition of definitions) {
    const defaultStatus = String(definition.defaultStatus) as ProviderCapabilityStatus;
    const capabilityStatus: ProviderCapabilityStatus = status !== 'CONNECTED'
      ? (status === 'AUTHORIZATION_REQUIRED' || status === 'EXPIRED' ? 'AUTHORIZATION_REQUIRED' : status === 'ERROR' ? 'ERROR' : status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'UNAVAILABLE')
      : result.verified
        ? defaultStatus
        : (defaultStatus === 'AVAILABLE' ? 'UNCONFIRMED' : defaultStatus);
    await repo.upsertCapabilityState({ connectionId, subjectType: 'CONNECTION', subjectId: connectionId, capabilityKey: String(definition.capabilityKey), status: capabilityStatus, source: result.verified ? 'PROVIDER_API' : 'ADAPTER', grantedScopes: connectionContext(row).grantedScopes, reason: result.verified ? null : result.reason });
  }
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId, userId: actorId, metadata: { action: 'connection_verified', targetId: connectionId, provider: String(row.providerKey), reason: result.reason } });
  const updated = await repo.getProviderConnection(workspaceId, connectionId);
  return updated ? (await applyEffectiveCapabilityPolicy(workspaceId, [updated]))[0] : null;
}

export async function changeWorkspaceProviderMode(workspaceId: string, connectionId: string, actorId: string, mode: ProviderMode) {
  await assertWorkspaceCapability({ workspaceId, userId: actorId, capability: 'providers.manage' });
  const connection = await repo.getProviderConnection(workspaceId, connectionId);
  if (!connection) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  if (connection.scopeType !== 'WORKSPACE') throw providerError('PROVIDER_SCOPE_IMMUTABLE', 'Shared provider connections cannot be reassigned from a workspace', undefined, 409);
  if (!await repo.updateConnectionMode(workspaceId, connectionId, mode)) throw providerError('PROVIDER_MODE_UPDATE_FAILED', 'Provider mode could not be updated', undefined, 500);
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId, userId: actorId, metadata: { action: 'mode_changed', targetId: connectionId, provider: connection.providerKey, previousMode: connection.mode, newMode: mode } });
  await repo.getProviderConnection(workspaceId, connectionId);
  return { ...connection, mode };
}

export async function disconnectWorkspaceProvider(workspaceId: string, connectionId: string, actorId: string) {
  await assertWorkspaceCapability({ workspaceId, userId: actorId, capability: 'providers.manage' });
  const connection = await repo.getProviderConnection(workspaceId, connectionId);
  if (!connection) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  const disconnected = await repo.disconnectConnection(workspaceId, connectionId);
  if (!disconnected) throw providerError('PROVIDER_DISCONNECT_FAILED', 'Provider connection could not be disconnected', undefined, 500);
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId, userId: actorId, metadata: { action: 'disconnected', targetId: connectionId, provider: connection.providerKey } });
  const updated = await repo.getProviderConnection(workspaceId, connectionId);
  return updated ? (await applyEffectiveCapabilityPolicy(workspaceId, [updated]))[0] : null;
}

export async function queueWorkspaceProviderSync(workspaceId: string, connectionId: string, actorId: string, syncType: string) {
  await assertWorkspaceCapability({ workspaceId, userId: actorId, capability: 'providers.manage' });
  const result = await repo.queueProviderSync(workspaceId, connectionId, actorId, syncType);
  if (!result) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  return result;
}

export async function grantSharedProviderAccess(input: { providerConnectionId: string; workspaceId: string; actorId: string; grantedCapabilities: string[] }) {
  const connection = await repo.getProviderConnectionInternal(input.providerConnectionId);
  if (!connection || String(connection.scopeType) === 'WORKSPACE') throw providerError('PROVIDER_SHARED_ACCESS_INVALID', 'Only shared provider connections can be granted to a workspace', undefined, 409);
  const definitions = await repo.listCapabilityDefinitions(String(connection.providerKey));
  const knownCapabilities = new Set(definitions.map((definition) => String(definition.capabilityKey)));
  const unknown = input.grantedCapabilities.filter((capability) => !knownCapabilities.has(capability));
  if (unknown.length > 0) throw providerError('PROVIDER_CAPABILITY_UNKNOWN', 'The shared access grant contains an unknown provider capability', { capabilities: unknown }, 400);
  const access = await repo.grantProviderConnectionAccess({ providerConnectionId: input.providerConnectionId, workspaceId: input.workspaceId, grantedBy: input.actorId, grantedCapabilities: input.grantedCapabilities });
  if (!access) throw providerError('PROVIDER_SHARED_ACCESS_FAILED', 'Provider access could not be granted', undefined, 500);
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId: input.workspaceId, userId: input.actorId, metadata: { action: 'shared_access_granted', targetId: input.providerConnectionId, providerConnectionId: input.providerConnectionId, grantedCapabilities: input.grantedCapabilities } });
  return access;
}

export async function revokeSharedProviderAccess(input: { providerConnectionId: string; workspaceId: string; actorId: string }) {
  const access = await repo.revokeProviderConnectionAccess(input.providerConnectionId, input.workspaceId);
  if (!access) throw providerError('PROVIDER_SHARED_ACCESS_NOT_FOUND', 'Provider workspace access was not found', undefined, 404);
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId: input.workspaceId, userId: input.actorId, metadata: { action: 'shared_access_revoked', targetId: input.providerConnectionId, providerConnectionId: input.providerConnectionId } });
  return access;
}

export async function listWorkspaceProviderMappings(workspaceId: string, luluObjectType?: string, luluObjectId?: string) {
  return repo.listObjectMappings(workspaceId, luluObjectType, luluObjectId);
}

export async function createWorkspaceProviderMapping(input: { workspaceId: string; actorId: string; providerConnectionId: string; providerAccountId: string; providerAssetId?: string | null; luluObjectType: string; luluObjectId: string; externalObjectType: string; externalObjectId: string; sourceOfTruth: 'LULU_MASTER' | 'PROVIDER_MASTER' | 'BIDIRECTIONAL' | 'READ_ONLY' | 'LULU_TO_PROVIDER' }) {
  await assertWorkspaceCapability({ workspaceId: input.workspaceId, userId: input.actorId, capability: 'providers.manage' });
  const mapping = await repo.createObjectMapping(input);
  if (!mapping) throw providerError('PROVIDER_MAPPING_CREATE_FAILED', 'Provider object mapping could not be created', undefined, 500);
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId: input.workspaceId, userId: input.actorId, metadata: { action: 'object_mapping_created', targetId: String(mapping.id), provider: input.providerConnectionId } });
  return mapping;
}

export function evaluateProviderHealth(connection: Pick<repo.ProviderConnection, 'status' | 'lastSuccessAt' | 'lastError' | 'rateLimitResetAt' | 'lastWebhookAt' | 'consecutiveFailures'>) {
  return evaluateStoredHealth(connection as unknown as Record<string, unknown>);
}

function webhookSecret(providerKey: string) {
  const raw = env.PROVIDER_WEBHOOK_SECRETS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[providerKey] ?? parsed['*'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function verifyProviderWebhookSignature(provider: string, rawBody: string, headers: { signature?: string; timestamp?: string; nonce?: string }) {
  const providerKey = canonicalProviderKey(provider);
  if (!isProviderRegistered(providerKey)) throw providerError('PROVIDER_NOT_REGISTERED', 'This provider is not registered in the Provider Control Plane', { provider }, 404);
  if (providerKey === 'airwallex') throw providerError('PROVIDER_WEBHOOK_USE_BILLING_ENDPOINT', 'Airwallex webhooks must use the verified billing webhook endpoint', undefined, 409);
  const secret = webhookSecret(providerKey);
  if (!secret) throw providerError('PROVIDER_WEBHOOK_VERIFICATION_UNAVAILABLE', 'No verified webhook secret is configured for this provider', { provider: providerKey }, 503);
  if (!headers.signature) throw providerError('PROVIDER_WEBHOOK_SIGNATURE_MISSING', 'Provider webhook signature is required', undefined, 403);
  const timestamp = headers.timestamp ?? '';
  if (timestamp) {
    const numericTimestamp = Number(timestamp);
    if (!Number.isFinite(numericTimestamp) || Math.abs(Date.now() - numericTimestamp * 1_000) > 300_000) throw providerError('PROVIDER_WEBHOOK_TIMESTAMP_INVALID', 'Provider webhook timestamp is invalid or expired', undefined, 403);
  }
  const payload = `${timestamp}${headers.nonce ?? ''}${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (headers.signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(headers.signature), Buffer.from(expected))) throw providerError('PROVIDER_WEBHOOK_SIGNATURE_INVALID', 'Provider webhook signature could not be verified', undefined, 403);
  return { providerKey, verified: true } as const;
}

function eventIdFromPayload(payload: Record<string, unknown>, header?: string) {
  const nestedEvent = payload.event && typeof payload.event === 'object' ? payload.event as Record<string, unknown> : null;
  const candidate = header ?? payload.id ?? payload.event_id ?? payload.eventId ?? nestedEvent?.id;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

export async function ingestProviderWebhook(input: { provider: string; rawBody: string; payload: Record<string, unknown>; signature?: string; timestamp?: string; nonce?: string; connectionId?: string; accountId?: string; correlationId?: string; eventId?: string }) {
  const providerKey = canonicalProviderKey(input.provider);
  const verified = providerKey === 'unifyport'
    ? verifyUnifyPortWebhookSignature(input.rawBody, { ...(input.signature ? { signature: input.signature } : {}), ...(input.timestamp ? { timestamp: input.timestamp } : {}) })
    : verifyProviderWebhookSignature(input.provider, input.rawBody, { ...(input.signature ? { signature: input.signature } : {}), ...(input.timestamp ? { timestamp: input.timestamp } : {}), ...(input.nonce ? { nonce: input.nonce } : {}) });
  const externalEventId = eventIdFromPayload(input.payload, input.eventId);
  if (!externalEventId) throw providerError('PROVIDER_WEBHOOK_EVENT_ID_MISSING', 'Provider webhook event ID is required', undefined, 400);
  const eventType = typeof input.payload.type === 'string' ? input.payload.type : typeof input.payload.event_type === 'string' ? input.payload.event_type : 'provider.event';
  const payloadHash = crypto.createHash('sha256').update(input.rawBody).digest('hex');
  const result = await repo.claimWebhookEvent({ providerKey: verified.providerKey, externalEventId, payloadHash, eventType, providerConnectionId: input.connectionId ?? null, providerAccountId: input.accountId ?? null, correlationId: input.correlationId ?? null, normalizedMetadata: { providerKey: verified.providerKey, eventType } });
  return { ...result, providerKey: verified.providerKey, externalEventId, verified: true };
}

export function providerStatusMatrix() {
  return PROVIDER_CATALOG.map(({providerKey,implementationStatus})=>[providerKey,implementationStatus] as const);
}

export function isProviderMode(value: string): value is ProviderMode {
  return ['LULU_MANAGED', 'CUSTOMER_OWNED', 'PARTNER_MANAGED', 'HYBRID'].includes(value);
}

export function providerExists(value: string) {
  return Boolean(getProviderCatalogEntry(canonicalProviderKey(value)));
}
