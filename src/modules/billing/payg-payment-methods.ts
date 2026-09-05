import { env } from '../../config/env.js';

export const PAYG_DIRECT_PAYMENT_METHODS = ['card', 'alipaycn', 'wechatpay'] as const;

export type PaygDirectPaymentMethod = (typeof PAYG_DIRECT_PAYMENT_METHODS)[number];

export function parsePaygDirectPaymentMethods(value: string): PaygDirectPaymentMethod[] {
  const supported = new Set<string>(PAYG_DIRECT_PAYMENT_METHODS);
  const configured = value
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is PaygDirectPaymentMethod => supported.has(value));

  const methods = [...new Set(configured)] as PaygDirectPaymentMethod[];
  return methods.length > 0 ? methods : ['card'];
}

export function getPaygDirectPaymentMethods(): PaygDirectPaymentMethod[] {
  return parsePaygDirectPaymentMethods(env.AIRWALLEX_PAYG_DIRECT_PAYMENT_METHODS);
}

export function isPaygDirectPaymentMethod(value: string | null | undefined): value is PaygDirectPaymentMethod {
  return typeof value === 'string' && (PAYG_DIRECT_PAYMENT_METHODS as readonly string[]).includes(value);
}

export function getPaygInvoicePaymentMethods(preferredMethod?: string | null): PaygDirectPaymentMethod[] {
  const configured = getPaygDirectPaymentMethods();
  return isPaygDirectPaymentMethod(preferredMethod) && configured.includes(preferredMethod)
    ? [preferredMethod]
    : configured;
}
