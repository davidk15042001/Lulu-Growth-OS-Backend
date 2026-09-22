import { createStorefrontPaymentLink } from '../billing/airwallex.service.js';
import * as repo from './storefront.repo.js';

/**
 * Creates the canonical storefront order first, then creates the hosted
 * provider checkout outside the database write. The checkout session remains
 * pending until the signed provider webhook verifies the payment.
 */
export async function createCheckout(
  slug: string,
  token: string,
  email: string,
  shippingAddress: Record<string, unknown>,
) {
  const checkout = await repo.createCheckout(slug, token, email, shippingAddress);
  if (!checkout || checkout === undefined || 'empty' in checkout || !checkout.paymentRequired || checkout.paymentUrl) return checkout;

  try {
    const payment = await createStorefrontPaymentLink({
      checkoutId: checkout.id,
      orderId: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency,
      customerEmail: email,
    });
    return await repo.attachPaymentLink({
      checkoutId: checkout.id,
      provider: 'airwallex',
      providerSessionId: payment.providerPaymentLinkId,
      paymentUrl: payment.paymentUrl,
      providerStatus: payment.providerStatus,
    });
  } catch (error) {
    await repo.markCheckoutPaymentFailed(checkout.id, error instanceof Error ? error.name : 'PAYMENT_LINK_CREATE_FAILED');
    throw error;
  }
}
