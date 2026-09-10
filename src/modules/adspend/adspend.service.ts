import { AppError } from '../../utils/app-error.js';
import { createAdSpendProviderPayment, syncAdSpendProviderPayment } from '../billing/airwallex.service.js';
import {
  AD_SPEND_FEE_BASIS_POINTS,
  createAdSpendTopup as createTopupRecord,
  failAdSpendTopup,
  getAdSpendOverview,
  getAdSpendTopup,
  publicTopup,
  type AdSpendPaymentMethod,
} from './adspend.repo.js';

export function calculateAdSpendCharge(amount: number) {
  if (![10_000, 25_000, 50_000, 90_000].includes(amount)) {
    throw new AppError(422, 'AD_SPEND_PACKAGE_INVALID', 'Choose an available advertising package.');
  }
  const netMinor = Math.round(amount * 100);
  if (!Number.isSafeInteger(netMinor) || netMinor < 100) {
    throw new AppError(422, 'AD_SPEND_AMOUNT_INVALID', 'Ad spend must be at least CNY 1.00.');
  }
  const feeMinor = Math.round(netMinor * AD_SPEND_FEE_BASIS_POINTS / 10_000);
  return {
    netAmount: netMinor / 100,
    feeAmount: feeMinor / 100,
    totalAmount: (netMinor + feeMinor) / 100,
    feeBasisPoints: AD_SPEND_FEE_BASIS_POINTS,
    feePercent: 4,
    currency: 'CNY' as const,
  };
}

export { getAdSpendOverview };

export async function startAdSpendTopup(input: {
  workspaceId: string;
  userId: string;
  amount: number;
  paymentMethod: AdSpendPaymentMethod;
  returnUrl: string;
}) {
  const charge = calculateAdSpendCharge(input.amount);
  const topup = await createTopupRecord({
    workspaceId: input.workspaceId,
    userId: input.userId,
    netAmount: charge.netAmount,
    feeAmount: charge.feeAmount,
    totalAmount: charge.totalAmount,
    paymentMethod: input.paymentMethod,
  });
  try {
    const providerPayment = await createAdSpendProviderPayment(topup, input.returnUrl);
    return { topup: publicTopup(providerPayment), charge, adsStartAutomaticallyAfterPayment: true };
  } catch (error) {
    await failAdSpendTopup(topup.id, error instanceof AppError ? error.code : 'AD_SPEND_PAYMENT_CREATE_FAILED', error instanceof Error ? error.message : 'Unknown payment error');
    throw error;
  }
}

export async function syncAdSpendTopup(workspaceId: string, topupId: string) {
  const topup = await getAdSpendTopup(workspaceId, topupId);
  if (!topup) throw new AppError(404, 'AD_SPEND_TOPUP_NOT_FOUND', 'Ad spend top-up not found.');
  const updated = await syncAdSpendProviderPayment(topup);
  if (!updated) throw new AppError(404, 'AD_SPEND_TOPUP_NOT_FOUND', 'Ad spend top-up not found.');
  return publicTopup(updated);
}
