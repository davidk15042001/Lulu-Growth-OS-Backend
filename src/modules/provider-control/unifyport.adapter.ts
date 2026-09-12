import { AppError } from '../../utils/app-error.js';
import * as omniRepo from '../omnichannel/omnichannel.repo.js';
import { getAccount, getWorkspace, isUnifyPortConfigured, isUnifyPortWebhookConfigured, listAccounts } from './unifyport.client.js';
import type { ProviderAdapter, ProviderAdapterContext, ProviderCapabilityStatus, ProviderDiscoveredAccount, ProviderDiscoveredAsset, ProviderHealthStatus, ProviderSyncStatus, ProviderVerificationResult } from './provider.types.js';

function errorStatus(error: unknown): { status: ProviderHealthStatus; connection: ProviderVerificationResult['status']; authorizationState: ProviderVerificationResult['authorizationState'] } {
  if (error instanceof AppError && error.status === 401) return { status: 'AUTHORIZATION_REQUIRED', connection: 'AUTHORIZATION_REQUIRED', authorizationState: 'REAUTH_REQUIRED' };
  return { status: 'ERROR', connection: 'ERROR', authorizationState: 'UNKNOWN' };
}

function accountId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const candidate=text(value);
    if(candidate)return candidate;
  }
  return null;
}

function omniMessageType(value: unknown) {
  const type=(text(value)??'text').toLowerCase();
  if(type.includes('image'))return 'IMAGE';
  if(type.includes('video'))return 'VIDEO';
  if(type.includes('audio')||type.includes('voice'))return 'AUDIO';
  if(type.includes('document')||type.includes('file'))return 'FILE';
  if(type.includes('location'))return 'LOCATION';
  if(type.includes('contact'))return 'CONTACT';
  return 'TEXT';
}

function normalizeInbound(payload:Record<string,unknown>,fallbackEventId:string) {
  const event=record(payload.event);
  const eventData=record(event.data);
  const rootData=record(payload.data);
  const data=Object.keys(eventData).length?eventData:rootData;
  const messageCandidate=record(data.message);
  const rootMessage=record(payload.message);
  const message=Object.keys(messageCandidate).length?messageCandidate:Object.keys(rootMessage).length?rootMessage:data;
  const conversation=record(message.conversation);
  const chat=record(message.chat);
  const sender=record(message.sender);
  const from=record(message.from);
  const textObject=record(message.text);
  const media=record(message.media);
  const account=record(data.account);
  const accountId=firstText(payload.account_id,payload.accountId,event.account_id,event.accountId,data.account_id,data.accountId,account.id);
  const messageId=firstText(message.id,message.message_id,data.message_id,payload.message_id,fallbackEventId);
  const senderId=firstText(sender.id,from.id,message.from,data.from,conversation.participant_id,conversation.participantId,conversation.id,chat.id);
  const conversationId=firstText(conversation.id,chat.id,data.conversation_id,data.conversationId,senderId);
  const body=firstText(message.text,textObject.body,message.body,message.content,message.caption,data.text,data.body)??'';
  const mediaUrl=firstText(message.url,media.url,data.media_url,data.mediaUrl);
  if(!accountId||!messageId||!senderId)return null;
  return {accountId,messageId,senderId,conversationId,body,messageType:omniMessageType(message.type??data.message_type??data.type),mediaUrl,senderName:firstText(sender.name,from.name,message.sender_name,data.sender_name)};
}

function lifecycleStatus(eventType:string) {
  const normalized=eventType.toLowerCase();
  if(normalized.includes('auth.succeeded')||normalized.includes('authenticated')||normalized.includes('started'))return 'ACTIVE' as const;
  if(normalized.includes('auth.required'))return 'AUTHORIZATION_REQUIRED' as const;
  if(normalized.includes('auth.failed')||normalized.includes('error'))return 'ERROR' as const;
  if(normalized.includes('stopped')||normalized.includes('disconnected'))return 'DISCONNECTED' as const;
  return null;
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
    const accounts=await listAccounts();
    const hasRunningWhatsApp=accounts.some(account=>account.provider==='whatsapp'&&account.status==='active'&&['running','ready','connected'].includes(String(account.runtime_status??'').toLowerCase()));
    return [
      { capabilityKey: 'unifyport.workspace.read', status: 'AVAILABLE' as ProviderCapabilityStatus },
      { capabilityKey: 'unifyport.accounts.read', status: 'AVAILABLE' as ProviderCapabilityStatus },
      { capabilityKey: 'unifyport.accounts.manage', status: 'AVAILABLE' as ProviderCapabilityStatus },
      { capabilityKey: 'unifyport.messages.send', status: hasRunningWhatsApp?'AVAILABLE' as ProviderCapabilityStatus:'UNCONFIRMED' as ProviderCapabilityStatus, ...(hasRunningWhatsApp?{}:{reason:'An authorized, running WhatsApp account is required.'}) },
      { capabilityKey: 'unifyport.messages.read', status: hasRunningWhatsApp&&isUnifyPortWebhookConfigured()?'AVAILABLE' as ProviderCapabilityStatus:'UNCONFIRMED' as ProviderCapabilityStatus, ...(hasRunningWhatsApp&&isUnifyPortWebhookConfigured()?{}:{reason:'A running WhatsApp account and verified webhook endpoint are required.'}) },
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
    const payload=record(input.metadata.eventPayload);
    if(input.eventType.toLowerCase()==='message.received'){
      const inbound=normalizeInbound(payload,input.externalEventId);
      if(!inbound)return {handled:false,details:{reason:'UNIFYPORT_MESSAGE_SHAPE_UNRECOGNIZED',eventType:input.eventType,externalEventId:input.externalEventId}};
      const result=await omniRepo.ingestUnifyPortInbound({...inbound,eventId:input.externalEventId,metadata:{providerEventType:input.eventType}});
      return {handled:result.routed,details:result};
    }
    const identityStatus=lifecycleStatus(input.eventType);
    if(identityStatus){
      const event=record(payload.event);
      const data=record(payload.data);
      const account=record(data.account);
      const externalAccountId=firstText(payload.account_id,payload.accountId,event.account_id,event.accountId,data.account_id,data.accountId,account.id);
      if(!externalAccountId)return {handled:false,details:{reason:'UNIFYPORT_ACCOUNT_ID_MISSING',eventType:input.eventType}};
      const identity=await omniRepo.updateUnifyPortIdentityStatus(externalAccountId,identityStatus);
      return {handled:Boolean(identity),details:{accountId:externalAccountId,status:identityStatus,identityUpdated:Boolean(identity)}};
    }
    return {handled:false,details:{eventType:input.eventType,externalEventId:input.externalEventId,reason:'UNIFYPORT_EVENT_NOT_ACTIONABLE'}};
  }
}
