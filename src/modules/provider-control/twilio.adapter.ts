import { AppError } from '../../utils/app-error.js';
import { getTwilioAccount, isTwilioConfigured, isTwilioWebhookConfigured } from './twilio.client.js';
import type { ProviderAdapter, ProviderAdapterContext, ProviderCapabilityStatus, ProviderHealthStatus, ProviderVerificationResult } from './provider.types.js';

function failure(error: unknown): { status: ProviderHealthStatus; connection: ProviderVerificationResult['status']; authorization: ProviderVerificationResult['authorizationState']; reason: string } {
  const auth = error instanceof AppError && (error.status === 401 || error.status === 403 || error.code === 'TWILIO_API_ERROR');
  return { status: auth ? 'AUTHORIZATION_REQUIRED' : 'ERROR', connection: auth ? 'AUTHORIZATION_REQUIRED' : 'ERROR', authorization: auth ? 'REAUTH_REQUIRED' : 'UNKNOWN', reason: error instanceof Error ? error.message : 'Twilio verification failed.' };
}

export class TwilioAdapter implements ProviderAdapter {
  readonly providerKey = 'twilio';

  async verifyConnection(_context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!isTwilioConfigured()) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Twilio credentials are not configured.' };
    try {
      const account = await getTwilioAccount();
      const sid = typeof account.sid === 'string' ? account.sid : 'configured account';
      const status = typeof account.status === 'string' ? account.status : 'active';
      if (status !== 'active') return { verified: false, status: 'SUSPENDED', authorizationState: 'AUTHORIZED', healthStatus: 'DEGRADED', reason: `Twilio account ${sid} is ${status}.` };
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `Twilio account ${sid} is reachable.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = failure(error);
      return { verified: false, status: state.connection, authorizationState: state.authorization, healthStatus: state.status, reason: state.reason };
    }
  }

  async getHealth(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(_context: ProviderAdapterContext) {
    const rest = isTwilioConfigured() ? 'AVAILABLE' : 'AUTHORIZATION_REQUIRED';
    const webhook = isTwilioWebhookConfigured() ? 'AVAILABLE' : 'AUTHORIZATION_REQUIRED';
    return [
      { capabilityKey: 'twilio.messages.send', status: rest as ProviderCapabilityStatus, ...(rest === 'AVAILABLE' ? {} : { reason: 'Twilio REST credentials are not configured.' }) },
      { capabilityKey: 'twilio.messages.receive', status: webhook as ProviderCapabilityStatus, ...(webhook === 'AVAILABLE' ? {} : { reason: 'TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_URL are required.' }) },
      { capabilityKey: 'twilio.messages.status', status: webhook as ProviderCapabilityStatus, ...(webhook === 'AVAILABLE' ? {} : { reason: 'A verified Twilio status callback is not configured.' }) },
    ];
  }
}
