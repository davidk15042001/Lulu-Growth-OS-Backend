import { AppError } from '../../utils/app-error.js';
import { getAccount, getWorkspace, isUnifyPortConfigured, listAccounts } from './unifyport.client.js';
import type { ProviderAdapter, ProviderAdapterContext, ProviderCapabilityStatus, ProviderDiscoveredAccount, ProviderDiscoveredAsset, ProviderHealthStatus, ProviderSyncStatus, ProviderVerificationResult } from './provider.types.js';

function errorStatus(error: unknown): { status: ProviderHealthStatus; connection: ProviderVerificationResult['status']; authorizationState: ProviderVerificationResult['authorizationState'] } {
  if (error instanceof AppError && error.status === 401) return { status: 'AUTHORIZATION_REQUIRED', connection: 'AUTHORIZATION_REQUIRED', authorizationState: 'REAUTH_REQUIRED' };
  return { status: 'ERROR', connection: 'ERROR', authorizationState: 'UNKNOWN' };
}

function accountId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export class UnifyPortAdapter implements ProviderAdapter {
  readonly providerKey = 'unifyport';

  async verifyConnection(_context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!isUnifyPortConfigured()) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'UNIFYPORT_API_KEY is not configured.' };
    try {
      const workspace = await getWorkspace();
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `UnifyPort workspace ${accountId(workspace.id) ?? 'configured'} is reachable.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = errorStatus(error);
      return { verified: false, status: state.connection, authorizationState: state.authorizationState, healthStatus: state.status, reason: error instanceof Error ? error.message : 'UnifyPort workspace verification failed.' };
    }
  }

  async getHealth(_context: ProviderAdapterContext) {
    const result = await this.verifyConnection(_context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(_context: ProviderAdapterContext) {
    if (!isUnifyPortConfigured()) {
      return [
        { capabilityKey: 'unifyport.workspace.read', status: 'AUTHORIZATION_REQUIRED' as ProviderCapabilityStatus, reason: 'UNIFYPORT_API_KEY is not configured.' },
        { capabilityKey: 'unifyport.accounts.read', status: 'AUTHORIZATION_REQUIRED' as ProviderCapabilityStatus, reason: 'UNIFYPORT_API_KEY is not configured.' },
        { capabilityKey: 'unifyport.accounts.manage', status: 'AUTHORIZATION_REQUIRED' as ProviderCapabilityStatus, reason: 'UNIFYPORT_API_KEY is not configured.' },
        { capabilityKey: 'unifyport.messages.send', status: 'UNCONFIRMED' as ProviderCapabilityStatus, reason: 'A provider account must be authorized before messages can be sent.' },
        { capabilityKey: 'unifyport.messages.read', status: 'UNCONFIRMED' as ProviderCapabilityStatus, reason: 'Inbound messages arrive through a verified webhook.' },
      ];
    }
    return [
      { capabilityKey: 'unifyport.workspace.read', status: 'AVAILABLE' as ProviderCapabilityStatus },
      { capabilityKey: 'unifyport.accounts.read', status: 'AVAILABLE' as ProviderCapabilityStatus },
      { capabilityKey: 'unifyport.accounts.manage', status: 'AVAILABLE' as ProviderCapabilityStatus },
      { capabilityKey: 'unifyport.messages.send', status: 'UNCONFIRMED' as ProviderCapabilityStatus, reason: 'An authorized provider account is required.' },
      { capabilityKey: 'unifyport.messages.read', status: 'UNCONFIRMED' as ProviderCapabilityStatus, reason: 'A verified webhook endpoint is required.' },
    ];
  }

  async discoverAccounts(_context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const accounts = await listAccounts();
    return accounts.flatMap((account) => {
      const externalAccountId = accountId(account.id);
      if (!externalAccountId) return [];
      return [{ externalAccountId, name: accountId(account.name), accountType: accountId(account.provider), status: account.status === 'active' ? 'CONNECTED' : 'UNKNOWN', country: null, currency: null, timezone: null, metadata: { provider: account.provider ?? null, region: account.region ?? null, runtimeStatus: account.runtime_status ?? null } }];
    });
  }

  async discoverAssets(_context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const externalAccountId = account.externalAccountId;
    const remote = await getAccount(externalAccountId);
    return [{ externalAssetId: externalAccountId, assetType: 'unifyport_account', displayName: account.name ?? remote.name ?? externalAccountId, status: remote.status === 'active' ? 'CONNECTED' : 'UNKNOWN', capabilities: { runtimeStatus: remote.runtime_status ?? null }, metadata: { provider: remote.provider ?? null, region: remote.region ?? null } }];
  }

  async sync(_context: ProviderAdapterContext, _syncType: string): Promise<{ status: ProviderSyncStatus; details?: Record<string, unknown> }> {
    const accounts = await listAccounts();
    return { status: 'SUCCESS', details: { accountCount: accounts.length } };
  }

  async handleWebhook(input: { eventType: string; externalEventId: string; metadata: Record<string, unknown> }) {
    return { handled: true, details: { eventType: input.eventType, externalEventId: input.externalEventId, note: 'Webhook persisted by Provider Control Plane; channel normalization is handled by OmniChannel.' } };
  }
}

