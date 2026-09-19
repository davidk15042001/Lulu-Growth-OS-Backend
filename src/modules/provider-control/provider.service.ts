import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { resolveWorkspaceEntitlements } from '../entitlements/entitlement.service.js';
import * as repo from './provider.repo.js';
import { PROVIDER_CATALOG, RETIRED_PROVIDER_KEYS, canonicalProviderKey, getProviderAdapter, getProviderCatalogEntry, getProviderRuntimeReadiness, isProviderRegistered, providerError } from './provider-registry.js';
import type { ProviderCapabilityStatus, ProviderConnectionStatus, ProviderHealthStatus, ProviderMode } from './provider.types.js';
import { verifyWebhookSignature as verifyUnifyPortWebhookSignature } from './unifyport.client.js';

export async function listProviderCatalog() {
  const catalog = await repo.listProviderCatalog();
  return catalog
    .filter((entry) => !RETIRED_PROVIDER_KEYS.has(canonicalProviderKey(String(entry.providerKey))))
    .map((entry) => ({ ...entry, runtime: getProviderRuntimeReadiness(String(entry.providerKey)) }));
}

const PROVIDER_ENTITLEMENTS: Record<string, string> = {
  google_ads: 'advertising.google',
  meta: 'advertising.meta',
  lulu_managed_website: 'website.managed_mode',
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
  const active = (await repo.listProviderConnections(workspaceId)).filter((connection) => !RETIRED_PROVIDER_KEYS.has(canonicalProviderKey(connection.providerKey)));
  return applyEffectiveCapabilityPolicy(workspaceId, active);
}

export async function listAdminProviders() {
  const connections = await repo.listAdminProviderConnections() as Array<Record<string, unknown>>;
  return connections.filter((connection) => !RETIRED_PROVIDER_KEYS.has(canonicalProviderKey(String(connection['providerKey']))));
}

export async function getWorkspaceProvider(workspaceId: string, connectionId: string) {
  const connection = await repo.getProviderConnection(workspaceId, connectionId);
  if (!connection) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  if (RETIRED_PROVIDER_KEYS.has(canonicalProviderKey(connection.providerKey))) throw providerError('PROVIDER_RETIRED', 'This provider has been retired. Use Lulu managed Website and Shop instead.', { provider: connection.providerKey }, 410);
  return (await applyEffectiveCapabilityPolicy(workspaceId, [connection]))[0];
}

function connectionContext(row: Record<string, unknown>) {
  return {
    connectionId: String(row.id),
    providerKey: String(row.providerKey),
    workspaceId: row.workspaceId == null ? null : String(row.workspaceId),
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
  if (RETIRED_PROVIDER_KEYS.has(canonicalProviderKey(String(row.providerKey)))) throw providerError('PROVIDER_RETIRED', 'This provider has been retired. Use Lulu managed Website and Shop instead.', { provider: row.providerKey }, 410);
  const adapter = getProviderAdapter(String(row.providerKey));
  const context = connectionContext(row);
  const result = await adapter.verifyConnection(context);
  let adapterCapabilities: Array<{ capabilityKey: string; status: ProviderCapabilityStatus; reason?: string }> = [];
  let capabilityProbeError: string | null = null;
  if (result.verified && adapter.getCapabilities) {
    try {
      adapterCapabilities = await adapter.getCapabilities(context);
    } catch (error) {
      capabilityProbeError = error instanceof Error ? error.message.slice(0, 500) : 'Provider capability probe failed.';
    }
  }
  const capabilityByKey = new Map(adapterCapabilities.map((capability) => [capability.capabilityKey, capability]));
  const health = result.healthStatus;
  const status = result.status as ProviderConnectionStatus;
  await repo.updateConnectionVerification({ workspaceId, connectionId, status, authorizationState: result.authorizationState, healthStatus: health, healthReason: result.reason, lastVerifiedAt: new Date(), lastSuccessAt: result.lastSuccessAt ? new Date(result.lastSuccessAt) : null, lastError: result.verified ? null : result.reason });
  const definitions = await repo.listCapabilityDefinitions(String(row.providerKey));
  for (const definition of definitions) {
    const defaultStatus = String(definition.defaultStatus) as ProviderCapabilityStatus;
    const capability = capabilityByKey.get(String(definition.capabilityKey));
    const capabilityStatus: ProviderCapabilityStatus = status !== 'CONNECTED'
      ? (status === 'AUTHORIZATION_REQUIRED' || status === 'EXPIRED' ? 'AUTHORIZATION_REQUIRED' : status === 'ERROR' ? 'ERROR' : status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'UNAVAILABLE')
      : capabilityProbeError
        ? 'UNCONFIRMED'
        : capability
          ? capability.status
      : result.verified
        ? defaultStatus
        : (defaultStatus === 'AVAILABLE' ? 'UNCONFIRMED' : defaultStatus);
    await repo.upsertCapabilityState({ connectionId, subjectType: 'CONNECTION', subjectId: connectionId, capabilityKey: String(definition.capabilityKey), status: capabilityStatus, source: result.verified ? (capability ? 'PROVIDER_API' : 'ADAPTER') : 'ADAPTER', grantedScopes: context.grantedScopes, reason: capabilityProbeError ?? (capability?.reason ?? (result.verified ? null : result.reason)) });
  }
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId, userId: actorId, metadata: { action: 'connection_verified', targetId: connectionId, provider: String(row.providerKey), reason: result.reason } });
  const updated = await repo.getProviderConnection(workspaceId, connectionId);
  return updated ? (await applyEffectiveCapabilityPolicy(workspaceId, [updated]))[0] : null;
}

export type ProviderContractPhase = {
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  reason?: string;
  details?: Record<string, unknown>;
};

/**
 * Contract checks are deliberately conservative. A provider is only marked
 * PASSED when the real adapter can verify the connection and every optional
 * probe that the adapter advertises succeeds. No external resource is
 * created, changed, published, or deleted by this operation.
 */
export function classifyProviderContract(phases: Record<string, ProviderContractPhase>, capabilities: Array<{ status?: unknown }>): repo.ProviderContractCheck['status'] {
  const verification = phases.verification;
  if (!verification || verification.status !== 'PASSED') return 'FAILED';
  const failedOptionalPhase = Object.entries(phases).some(([key, phase]) => key !== 'verification' && phase.status === 'FAILED');
  if (failedOptionalPhase) return 'PARTIAL';
  if (capabilities.some((capability) => capability.status !== undefined && capability.status !== 'AVAILABLE')) return 'PARTIAL';
  return 'PASSED';
}

function contractErrorMessage(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' && error.trim().length > 0
      ? error
      : 'Provider contract phase failed.';
  return message.replaceAll(/(authorization|token|api[-_ ]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]').slice(0, 500);
}

export async function runWorkspaceProviderContractCheck(workspaceId: string, connectionId: string, actorId: string) {
  await assertWorkspaceCapability({ workspaceId, userId: actorId, capability: 'providers.manage' });
  const row = await repo.getProviderConnectionInternal(connectionId);
  if (!row || String(row.workspaceId) !== workspaceId) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  const providerKey = String(row.providerKey);
  if (RETIRED_PROVIDER_KEYS.has(canonicalProviderKey(providerKey))) throw providerError('PROVIDER_RETIRED', 'This provider has been retired. Use Lulu managed Website and Shop instead.', { provider: providerKey }, 410);
  const check = await repo.createProviderContractCheck({ workspaceId, providerConnectionId: connectionId, providerKey, createdBy: actorId });
  if (!check) throw providerError('PROVIDER_CONTRACT_CHECK_CREATE_FAILED', 'The provider contract check could not be created', undefined, 500);
  const adapter = getProviderAdapter(providerKey);
  const context = connectionContext(row);
  const phases: Record<string, ProviderContractPhase> = {};
  let capabilities: Array<Record<string, unknown>> = [];
  let terminalErrorCode: string | null = null;
  let terminalErrorMessage: string | null = null;

  try {
    const result = await adapter.verifyConnection(context);
    phases.verification = {
      status: result.verified ? 'PASSED' : 'FAILED',
      reason: result.reason,
      details: { connectionStatus: result.status, authorizationState: result.authorizationState, healthStatus: result.healthStatus },
    };
    if (!result.verified) {
      terminalErrorCode = result.status === 'AUTHORIZATION_REQUIRED' || result.status === 'EXPIRED' ? 'PROVIDER_AUTHORIZATION_REQUIRED' : 'PROVIDER_VERIFICATION_FAILED';
      terminalErrorMessage = result.reason;
    }
  } catch (error) {
    phases.verification = { status: 'FAILED', reason: contractErrorMessage(error) };
    terminalErrorCode = 'PROVIDER_VERIFICATION_ERROR';
    terminalErrorMessage = contractErrorMessage(error);
  }

  if (phases.verification.status === 'PASSED') {
    if (typeof adapter.getCapabilities === 'function') {
      try {
        const result = await adapter.getCapabilities(context);
        capabilities = result.map((item) => ({ capabilityKey: item.capabilityKey, status: item.status, ...(item.reason ? { reason: item.reason } : {}) }));
        phases.capabilities = { status: 'PASSED', details: { count: capabilities.length } };
      } catch (error) {
        phases.capabilities = { status: 'FAILED', reason: contractErrorMessage(error) };
      }
    } else phases.capabilities = { status: 'SKIPPED', reason: 'This adapter does not expose a capability probe.' };

    if (typeof adapter.getHealth === 'function') {
      try {
        const result = await adapter.getHealth(context);
        phases.health = { status: result.status === 'HEALTHY' ? 'PASSED' : 'FAILED', reason: result.reason, details: { healthStatus: result.status } };
      } catch (error) {
        phases.health = { status: 'FAILED', reason: contractErrorMessage(error) };
      }
    } else phases.health = { status: 'SKIPPED', reason: 'This adapter does not expose a health probe.' };

    if (typeof adapter.discoverAccounts === 'function') {
      try {
        const accounts = await adapter.discoverAccounts(context);
        let assets = 0;
        if (typeof adapter.discoverAssets === 'function') {
          for (const account of accounts.slice(0, 20)) assets += (await adapter.discoverAssets(context, account)).length;
        }
        phases.discovery = { status: 'PASSED', details: { accounts: accounts.length, assets } };
      } catch (error) {
        phases.discovery = { status: 'FAILED', reason: contractErrorMessage(error) };
      }
    } else phases.discovery = { status: 'SKIPPED', reason: 'This adapter does not expose account discovery.' };
  } else {
    phases.capabilities = { status: 'SKIPPED', reason: 'Skipped because connection verification failed.' };
    phases.health = { status: 'SKIPPED', reason: 'Skipped because connection verification failed.' };
    phases.discovery = { status: 'SKIPPED', reason: 'Skipped because connection verification failed.' };
  }

  const status = classifyProviderContract(phases, capabilities);
  const completed = await repo.finishProviderContractCheck({ workspaceId, checkId: check.id, status, phaseResults: phases, capabilities, errorCode: terminalErrorCode, errorMessage: terminalErrorMessage });
  await recordSecurityEvent({ eventType: 'PROVIDER_ACTION', workspaceId, userId: actorId, metadata: { action: 'contract_check_completed', targetId: connectionId, provider: providerKey, checkId: check.id, status } });
  return completed ?? { ...check, status, phaseResults: phases, capabilities, errorCode: terminalErrorCode, errorMessage: terminalErrorMessage, finishedAt: new Date().toISOString() };
}

export async function listWorkspaceProviderContractChecks(workspaceId: string, connectionId: string, limit = 10) {
  const connection = await repo.getProviderConnection(workspaceId, connectionId);
  if (!connection) throw providerError('PROVIDER_CONNECTION_NOT_FOUND', 'Provider connection not found', undefined, 404);
  return repo.listProviderContractChecks(workspaceId, connectionId, limit);
}

export type ProviderLaunchReadinessBlocker = {
  code: string;
  message: string;
};

export type ProviderLaunchReadinessConnection = {
  connectionId: string;
  providerKey: string;
  displayName: string;
  scopeType: repo.ProviderConnection['scopeType'];
  status: 'READY' | 'PENDING' | 'BLOCKED' | 'UNVERIFIED';
  ready: boolean;
  blockers: ProviderLaunchReadinessBlocker[];
  evidence: {
    connectionStatus: string;
    authorizationState: string;
    healthStatus: string;
    latestContractCheck: 'PASSED' | 'PARTIAL' | 'FAILED' | 'RUNNING' | 'NOT_RUN';
    contractCheckedAt: string | null;
    sync: Array<{
      syncType: string;
      status: string;
      lastSuccessAt: string | null;
      lastAttemptAt: string | null;
      lastError: string | null;
    }>;
  };
};

/**
 * Converts persisted provider state into an explicit production gate.  This
 * is intentionally pure so the same rules can be tested without a database
 * and so the UI can never mistake a merely configured connection for one that
 * is safe for autonomous execution.
 */
export function evaluateProviderLaunchReadiness(
  connection: repo.ProviderConnection,
  latestContractCheck?: repo.ProviderContractCheck,
): ProviderLaunchReadinessConnection {
  const blockers: ProviderLaunchReadinessBlocker[] = [];
  const runtime = getProviderRuntimeReadiness(connection.providerKey);
  if (!runtime.adapterRegistered) blockers.push({ code: 'ADAPTER_NOT_REGISTERED', message: 'No executable provider adapter is registered for this connection.' });
  if (connection.status !== 'CONNECTED') blockers.push({ code: 'CONNECTION_NOT_CONNECTED', message: `Connection status is ${connection.status.toLowerCase().replaceAll('_', ' ')}.` });
  if (connection.authorizationState !== 'AUTHORIZED') blockers.push({ code: 'AUTHORIZATION_REQUIRED', message: 'Provider authorization is not confirmed.' });
  if (connection.healthStatus !== 'HEALTHY') blockers.push({ code: 'HEALTH_NOT_CONFIRMED', message: contractErrorMessage(connection.healthReason ?? `Provider health is ${connection.healthStatus.toLowerCase().replaceAll('_', ' ')}.`) });
  let contractEvidence: ProviderLaunchReadinessConnection['evidence']['latestContractCheck'] = 'NOT_RUN';
  if (!latestContractCheck) {
    blockers.push({ code: 'CONTRACT_CHECK_NOT_RUN', message: 'Run a provider readiness check before enabling autonomous work.' });
  } else if (!latestContractCheck.finishedAt) {
    contractEvidence = 'RUNNING';
    blockers.push({ code: 'CONTRACT_CHECK_RUNNING', message: 'The provider readiness check is still running.' });
  } else if (latestContractCheck.status !== 'PASSED') {
    contractEvidence = latestContractCheck.status;
    blockers.push({ code: 'CONTRACT_CHECK_FAILED', message: contractErrorMessage(latestContractCheck.errorMessage ?? `The readiness check finished with status ${latestContractCheck.status.toLowerCase()}.`) });
  } else {
    contractEvidence = 'PASSED';
  }

  for (const capability of connection.capabilities) {
    if (capability.status !== 'AVAILABLE') blockers.push({ code: `CAPABILITY_${capability.status}`, message: `${capability.capabilityKey} is ${capability.status.toLowerCase().replaceAll('_', ' ')}.` });
  }

  // Sync errors originate in external adapters and can contain accidental
  // credential-shaped material (for example a provider URL with a query
  // token).  Readiness is a public workspace diagnostic, so expose only the
  // same redacted form used for health and contract failures.
  const sync = connection.syncStates.map((state) => ({ syncType: state.syncType, status: state.status, lastSuccessAt: state.lastSuccessAt, lastAttemptAt: state.lastAttemptAt, lastError: state.lastError ? contractErrorMessage(state.lastError) : null }));
  const pendingSync = connection.syncStates.some((state) => state.status === 'RUNNING');
  const failedSync = connection.syncStates.filter((state) => ['FAILED', 'PAUSED', 'PARTIAL'].includes(state.status));
  if (pendingSync) blockers.push({ code: 'SYNC_RUNNING', message: 'A provider synchronization is still running.' });
  for (const state of failedSync) blockers.push({ code: 'SYNC_NOT_HEALTHY', message: `${state.syncType} synchronization is ${state.status.toLowerCase()}.${state.lastError ? ` ${contractErrorMessage(state.lastError)}` : ''}` });

  const ready = blockers.length === 0;
  const status: ProviderLaunchReadinessConnection['status'] = ready
    ? 'READY'
    : blockers.some((blocker) => ['CONTRACT_CHECK_RUNNING', 'SYNC_RUNNING'].includes(blocker.code)) && !blockers.some((blocker) => blocker.code !== 'CONTRACT_CHECK_RUNNING' && blocker.code !== 'SYNC_RUNNING')
      ? 'PENDING'
      : latestContractCheck ? 'BLOCKED' : 'UNVERIFIED';
  return {
    connectionId: connection.id,
    providerKey: connection.providerKey,
    displayName: connection.displayName,
    scopeType: connection.scopeType,
    status,
    ready,
    blockers,
    evidence: {
      connectionStatus: connection.status,
      authorizationState: connection.authorizationState,
      healthStatus: connection.healthStatus,
      latestContractCheck: contractEvidence,
      contractCheckedAt: latestContractCheck?.finishedAt ?? null,
      sync,
    },
  };
}

export async function getWorkspaceProviderLaunchReadiness(workspaceId: string) {
  const connections = await listWorkspaceProviders(workspaceId);
  const checks = await repo.listLatestProviderContractChecks(workspaceId, connections.map((connection) => connection.id));
  const evaluated = connections.map((connection) => evaluateProviderLaunchReadiness(connection, checks.get(connection.id)));
  const readyCount = evaluated.filter((connection) => connection.ready).length;
  return {
    checkedAt: new Date().toISOString(),
    overallReady: evaluated.length > 0 && readyCount === evaluated.length,
    readyCount,
    totalConnections: evaluated.length,
    connections: evaluated,
  };
}

const PROVIDER_REQUIREMENT_ALIASES: Record<string, string[]> = {
  email: ['gmail', 'microsoft_email', 'imap_smtp'],
  website: ['lulu_managed_website'],
  whatsapp: ['whatsapp', 'unifyport'],
};

/**
 * Fail-closed gate used immediately before an autonomous external side
 * effect. A configured connection is not enough: it must have current
 * authorization, healthy state, passing contract evidence, available
 * capabilities, and no failed synchronization.
 */
export async function assertWorkspaceProviderLaunchReady(workspaceId: string, requestedProviderKey: string | null, reason = 'This action requires a verified provider connection.') {
  const requested = requestedProviderKey?.trim().toLowerCase() ?? '';
  if (!requested) throw providerError('PROVIDER_REQUIRED_FOR_AUTONOMOUS_ACTION', reason, undefined, 409);
  const candidates = PROVIDER_REQUIREMENT_ALIASES[requested] ?? [canonicalProviderKey(requested)];
  const readiness = await getWorkspaceProviderLaunchReadiness(workspaceId);
  const matching = readiness.connections.filter((connection) => candidates.includes(canonicalProviderKey(connection.providerKey)));
  const ready = matching.find((connection) => connection.ready);
  if (ready) return ready;
  if (!matching.length) {
    throw providerError('PROVIDER_CONNECTION_REQUIRED', `${reason} No ${requested} connection is configured for this workspace.`, { providerKey: requested, candidates }, 409);
  }
  throw providerError('PROVIDER_NOT_READY_FOR_AUTONOMOUS_EXECUTION', `${reason} The ${requested} connection is not ready for autonomous execution.`, {
    providerKey: requested,
    blockers: matching.flatMap((connection) => connection.blockers.slice(0, 8).map((blocker) => ({ providerKey: connection.providerKey, ...blocker }))).slice(0, 16),
  }, 409);
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

function eventTypeFromPayload(payload: Record<string, unknown>) {
  const nestedEvent = payload.event && typeof payload.event === 'object' ? payload.event as Record<string, unknown> : null;
  const candidate = payload.type ?? payload.event_type ?? payload.eventType ?? nestedEvent?.type ?? nestedEvent?.event_type;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : 'provider.event';
}

export async function ingestProviderWebhook(input: { provider: string; rawBody: string; payload: Record<string, unknown>; signature?: string; timestamp?: string; nonce?: string; connectionId?: string; accountId?: string; correlationId?: string; eventId?: string }) {
  const providerKey = canonicalProviderKey(input.provider);
  const verified = providerKey === 'unifyport'
    ? verifyUnifyPortWebhookSignature(input.rawBody, { ...(input.signature ? { signature: input.signature } : {}), ...(input.timestamp ? { timestamp: input.timestamp } : {}) })
    : verifyProviderWebhookSignature(input.provider, input.rawBody, { ...(input.signature ? { signature: input.signature } : {}), ...(input.timestamp ? { timestamp: input.timestamp } : {}), ...(input.nonce ? { nonce: input.nonce } : {}) });
  const externalEventId = eventIdFromPayload(input.payload, input.eventId);
  if (!externalEventId) throw providerError('PROVIDER_WEBHOOK_EVENT_ID_MISSING', 'Provider webhook event ID is required', undefined, 400);
  const eventType = eventTypeFromPayload(input.payload);
  const payloadHash = crypto.createHash('sha256').update(input.rawBody).digest('hex');
  const normalizedMetadata = providerKey === 'unifyport'
    ? { providerKey: verified.providerKey, eventType, eventPayload: input.payload }
    : { providerKey: verified.providerKey, eventType };
  const result = await repo.claimWebhookEvent({ providerKey: verified.providerKey, externalEventId, payloadHash, eventType, providerConnectionId: input.connectionId ?? null, providerAccountId: input.accountId ?? null, correlationId: input.correlationId ?? null, normalizedMetadata });
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
