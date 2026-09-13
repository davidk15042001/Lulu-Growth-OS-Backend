import { AppError } from '../../utils/app-error.js';
import {
  launchGoogleAdsAllocation,
  pauseGoogleAdsCampaign,
  type GoogleAdsOperation,
} from './google-ads-spend.service.js';

/**
 * Provider mutations remain one canonical entry point for both the autonomous
 * Office and the manual Workspace. Launch reserves a customer-authorized cap;
 * the reconciliation worker, not the mutation response, settles actual spend.
 */
export async function executeAdvertisingProviderOperation(workspaceId: string, input: GoogleAdsOperation) {
  if (input.provider !== 'google-ads') {
    throw new AppError(409, 'AD_PROVIDER_EXECUTION_UNAVAILABLE', `Autonomous paid-campaign execution is not enabled for provider ${String(input.provider)}.`);
  }
  if (input.action === 'pause') return pauseGoogleAdsCampaign(workspaceId, input);
  return launchGoogleAdsAllocation(workspaceId, input);
}
