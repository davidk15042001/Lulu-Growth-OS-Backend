import { AppError } from '../../utils/app-error.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { createAirwallexTransfer } from '../billing/airwallex.service.js';
import * as repo from './payout.repo.js';
import type { CreatePayoutAccountInput, RequestPayoutInput } from './payout.validator.js';

async function authorize(workspaceId: string, userId: string, capability: 'payouts.request' | 'payouts.manage') {
  await assertWorkspaceCapability({ workspaceId, userId, capability });
}

export async function list(workspaceId: string, userId: string, limit: number) {
  await authorize(workspaceId, userId, 'payouts.request');
  const [accounts, payouts] = await Promise.all([repo.listPayoutAccounts(workspaceId), repo.listPayouts(workspaceId, limit)]);
  return { accounts, ...payouts };
}

export async function createAccount(workspaceId: string, userId: string, input: CreatePayoutAccountInput) {
  await authorize(workspaceId, userId, 'payouts.manage');
  return repo.createPayoutAccount({ workspaceId, actorId: userId, ...input });
}

export async function request(workspaceId: string, userId: string, input: RequestPayoutInput) {
  await authorize(workspaceId, userId, 'payouts.request');
  return repo.requestPayout({ workspaceId, actorId: userId, ...input });
}

export async function submit(workspaceId: string, userId: string, payoutId: string) {
  await authorize(workspaceId, userId, 'payouts.manage');
  const claim = await repo.claimPayoutForSubmission(workspaceId, payoutId, userId);
  if (!claim.payout) throw new AppError(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
  if (!claim.shouldSubmit) return claim.payout;
  try {
    const provider = await createAirwallexTransfer({
      payoutId,
      beneficiaryId: await beneficiaryId(workspaceId, claim.payout.payoutAccountId),
      amount: claim.payout.amount,
      currency: claim.payout.currency,
      reference: `lulu-payout:${payoutId}`,
    });
    return repo.markPayoutSubmitted({
      workspaceId,
      payoutId,
      providerTransferId: provider.providerTransferId,
      providerStatus: provider.providerStatus,
      providerPayload: provider.providerResponse,
    });
  } catch (error) {
    const unknownOutcome = error instanceof AppError && /NETWORK|TIMEOUT/i.test(error.code);
    await repo.markPayoutSubmissionFailed(workspaceId, payoutId, error instanceof AppError ? error.code : 'PAYOUT_SUBMISSION_FAILED', unknownOutcome);
    throw error;
  }
}

async function beneficiaryId(workspaceId: string, payoutAccountId: string) {
  const accounts = await repo.listPayoutAccounts(workspaceId);
  const account = accounts.find((item) => item.id === payoutAccountId && item.status === 'ACTIVE');
  if (!account) throw new AppError(409, 'PAYOUT_ACCOUNT_NOT_FOUND', 'The selected payout account is no longer active.');
  return account.providerBeneficiaryId;
}
