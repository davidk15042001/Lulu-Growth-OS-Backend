export type ProviderMode = 'LULU_MANAGED' | 'CUSTOMER_OWNED' | 'PARTNER_MANAGED' | 'HYBRID';
export type ProviderScopeType = 'WORKSPACE' | 'ORGANIZATION' | 'LULU_PLATFORM' | 'PARTNER';
export type ProviderConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'AUTHORIZATION_REQUIRED' | 'EXPIRED' | 'ERROR' | 'SUSPENDED' | 'PROVIDER_REVIEW' | 'UNAVAILABLE';
export type ProviderAuthorizationState = 'AUTHORIZED' | 'REAUTH_REQUIRED' | 'NOT_AUTHORIZED' | 'UNKNOWN';
export type ProviderHealthStatus = 'HEALTHY' | 'DEGRADED' | 'AUTHORIZATION_REQUIRED' | 'RATE_LIMITED' | 'ERROR' | 'DISCONNECTED' | 'PROVIDER_REVIEW' | 'UNKNOWN';
export type ProviderCapabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'AUTHORIZATION_REQUIRED' | 'PROVIDER_REVIEW' | 'PLAN_REQUIRED' | 'BLOCKED' | 'UNCONFIRMED' | 'ERROR';
export type ProviderSyncStatus = 'IDLE' | 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'PAUSED';
export type ProviderImplementationStatus = 'IMPLEMENTED' | 'PARTIAL' | 'AUTHORIZATION_REQUIRED' | 'PROVIDER_REVIEW' | 'UNCONFIRMED' | 'NOT_IMPLEMENTED' | 'UNAVAILABLE';

export type ProviderVerificationResult = {
  verified: boolean;
  status: ProviderConnectionStatus;
  authorizationState: ProviderAuthorizationState;
  healthStatus: ProviderHealthStatus;
  reason: string;
  lastSuccessAt?: string | null;
};

export type ProviderDiscoveredAccount = {
  externalAccountId: string;
  name?: string | null;
  accountType?: string | null;
  status?: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'UNAVAILABLE' | 'UNKNOWN';
  currency?: string | null;
  timezone?: string | null;
  country?: string | null;
  metadata?: Record<string, unknown>;
};

export type ProviderDiscoveredAsset = {
  externalAssetId: string;
  assetType: string;
  displayName?: string | null;
  status?: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'UNAVAILABLE' | 'UNKNOWN';
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ProviderAdapterContext = {
  connectionId: string;
  providerKey: string;
  externalAccountId?: string | null;
  grantedScopes: string[];
  metadata: Record<string, unknown>;
};

/** Common provider lifecycle contract. Capability-specific adapters are
 * composed onto this base instead of one giant provider interface. */
export interface ProviderBaseAdapter {
  readonly providerKey: string;
  verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult>;
}

export interface ProviderAuthorizationAdapter extends ProviderBaseAdapter {
  refreshAuthorization?(context: ProviderAdapterContext): Promise<ProviderVerificationResult>;
}

export interface ProviderDiscoveryAdapter extends ProviderBaseAdapter {
  discoverAccounts?(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]>;
  discoverAssets?(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]>;
}

export interface ProviderCapabilityAdapter extends ProviderBaseAdapter {
  getCapabilities?(context: ProviderAdapterContext): Promise<Array<{ capabilityKey: string; status: ProviderCapabilityStatus; reason?: string }>>;
}

export interface ProviderHealthAdapter extends ProviderBaseAdapter {
  getHealth?(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }>;
}

export interface ProviderSyncAdapter extends ProviderBaseAdapter {
  sync?(context: ProviderAdapterContext, syncType: string): Promise<{ status: ProviderSyncStatus; cursor?: string | null; details?: Record<string, unknown> }>;
}

export interface ProviderWebhookAdapter extends ProviderBaseAdapter {
  handleWebhook?(input: { eventType: string; externalEventId: string; metadata: Record<string, unknown> }): Promise<{ handled: boolean; details?: Record<string, unknown> }>;
}

export type ProviderAdapter = ProviderBaseAdapter &
  Partial<Omit<ProviderAuthorizationAdapter, keyof ProviderBaseAdapter>> &
  Partial<Omit<ProviderDiscoveryAdapter, keyof ProviderBaseAdapter>> &
  Partial<Omit<ProviderCapabilityAdapter, keyof ProviderBaseAdapter>> &
  Partial<Omit<ProviderHealthAdapter, keyof ProviderBaseAdapter>> &
  Partial<Omit<ProviderSyncAdapter, keyof ProviderBaseAdapter>> &
  Partial<Omit<ProviderWebhookAdapter, keyof ProviderBaseAdapter>>;

export type ProviderCatalogEntry = {
  providerKey: string;
  displayName: string;
  category: string;
  implementationStatus: ProviderImplementationStatus;
  defaultMode: ProviderMode;
  capabilities: Array<{
    capabilityKey: string;
    displayName: string;
    requiredScopes: string[];
    defaultStatus: ProviderCapabilityStatus;
  }>;
};
