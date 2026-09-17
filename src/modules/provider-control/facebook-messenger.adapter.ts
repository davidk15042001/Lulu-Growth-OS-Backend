import { query } from '../../db/pool.js';
import { getTwilioAccount, isTwilioConfigured, isTwilioWebhookConfigured } from './twilio.client.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderSyncStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type MessengerIdentity = {
  externalIdentityId: string;
  displayName: string | null;
  status: string;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

/**
 * Facebook Messenger is delivered through the existing Twilio channel
 * transport. This adapter deliberately verifies the actual workspace sender
 * identity as well as the Twilio account; a catalog row alone is never enough
 * to make Messenger appear connected.
 */
export class FacebookMessengerAdapter implements ProviderAdapter {
  readonly providerKey = 'facebook_messenger';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  private async identity(context: ProviderAdapterContext): Promise<MessengerIdentity | null> {
    const { rows } = await query<MessengerIdentity>(
      `SELECT ci.external_identity_id AS "externalIdentityId",
              ci.display_name AS "displayName", ci.status,
              ci.capabilities, ci.metadata
         FROM omni_channel_identities ci
         JOIN omni_channels ch ON ch.id=ci.channel_id
        WHERE ch.channel_type='FACEBOOK_MESSENGER'
          AND ch.provider='twilio'
          AND ch.status='ACTIVE'
          AND ci.status='ACTIVE'
          AND (($1::uuid IS NULL AND ci.workspace_id IS NULL) OR ci.workspace_id=$1::uuid)
          AND ($2::text IS NULL OR lower(ci.external_identity_id)=lower($2))
        ORDER BY CASE WHEN ci.workspace_id=$1::uuid THEN 0 ELSE 1 END, ci.updated_at DESC
        LIMIT 1`,
      [context.workspaceId ?? null, context.externalAccountId ?? null],
    );
    return rows[0] ?? null;
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!isTwilioConfigured()) {
      return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Twilio REST credentials are not configured.' };
    }
    try {
      const account = await getTwilioAccount();
      const accountStatus = typeof account.status === 'string' ? account.status.toLowerCase() : 'unknown';
      if (accountStatus !== 'active') {
        return { verified: false, status: 'SUSPENDED', authorizationState: 'AUTHORIZED', healthStatus: 'DEGRADED', reason: `Twilio account ${typeof account.sid === 'string' ? account.sid : 'configured account'} is ${accountStatus}.` };
      }
      const identity = await this.identity(context);
      if (!identity) {
        return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'No active Facebook Messenger sender is registered for this workspace.' };
      }
      const webhookReady = isTwilioWebhookConfigured();
      return {
        verified: true,
        status: 'CONNECTED',
        authorizationState: 'AUTHORIZED',
        healthStatus: webhookReady ? 'HEALTHY' : 'DEGRADED',
        reason: webhookReady
          ? `Facebook Messenger sender ${identity.displayName ?? identity.externalIdentityId} is reachable through Twilio.`
          : 'The Facebook Messenger sender is reachable, but inbound/status webhooks are not configured.',
        lastSuccessAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        verified: false,
        status: 'ERROR',
        authorizationState: 'UNKNOWN',
        healthStatus: 'ERROR',
        reason: error instanceof Error ? error.message : 'Facebook Messenger verification failed.',
      };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const identity = await this.identity(context);
    const sender = Boolean(identity && identity.capabilities?.['messages.send'] === true);
    const webhook = Boolean(identity && isTwilioWebhookConfigured() && identity.capabilities?.['messages.inbound_webhook'] === true);
    return [
      { capabilityKey: 'facebook_messenger.messages.send', status: (isTwilioConfigured() && sender ? 'AVAILABLE' : 'AUTHORIZATION_REQUIRED') as ProviderCapabilityStatus, ...(!isTwilioConfigured() || !sender ? { reason: 'An active Twilio Messenger sender identity is required.' } : {}) },
      { capabilityKey: 'facebook_messenger.messages.receive', status: (webhook ? 'AVAILABLE' : 'AUTHORIZATION_REQUIRED') as ProviderCapabilityStatus, ...(!webhook ? { reason: 'A registered sender and verified Twilio webhook are required.' } : {}) },
      { capabilityKey: 'facebook_messenger.messages.status', status: (webhook && identity?.capabilities?.['messages.delivery_status'] === true ? 'AVAILABLE' : 'AUTHORIZATION_REQUIRED') as ProviderCapabilityStatus, ...(!(webhook && identity?.capabilities?.['messages.delivery_status'] === true) ? { reason: 'A registered sender and verified Twilio status callback are required.' } : {}) },
    ];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const identity = await this.identity(context);
    if (!identity) return [];
    return [{
      externalAccountId: identity.externalIdentityId,
      name: identity.displayName,
      accountType: 'messenger_sender',
      status: 'CONNECTED',
      metadata: { provider: 'twilio', capabilities: identity.capabilities, ...identity.metadata },
    }];
  }

  async discoverAssets(_context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    return [{
      externalAssetId: account.externalAccountId,
      assetType: 'messenger_sender',
      displayName: account.name ?? null,
      status: account.status ?? 'UNKNOWN',
      capabilities: { messagesSend: true, messagesReceive: isTwilioWebhookConfigured(), deliveryStatus: isTwilioWebhookConfigured() },
      metadata: { provider: 'twilio' },
    }];
  }

  async sync(context: ProviderAdapterContext, _syncType: string): Promise<{ status: ProviderSyncStatus; details?: Record<string, unknown> }> {
    const account = await this.discoverAccounts(context);
    return { status: 'SUCCESS', details: { accounts: account.length, webhookConfigured: isTwilioWebhookConfigured() } };
  }
}
