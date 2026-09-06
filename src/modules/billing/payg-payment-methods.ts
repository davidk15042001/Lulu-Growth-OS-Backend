import { env } from '../../config/env.js';

export const PAYG_DIRECT_PAYMENT_METHODS = ['card', 'alipaycn', 'wechatpay'] as const;
const PAYG_INVOICE_PAYMENT_METHOD_DISPLAY_ORDER = ['wechatpay', 'alipaycn', 'card'] as const;

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

export function getPaygInvoicePaymentMethods(_preferredMethod?: string | null): PaygDirectPaymentMethod[] {
  const configured = new Set(getPaygDirectPaymentMethods());
  // The selected workspace method controls Lulu's direct QR shortcut. A hosted
  // invoice must instead show every enabled method, so the payer can choose
  // WeChat Pay, Alipay, or card on the Airwallex invoice page.
  return PAYG_INVOICE_PAYMENT_METHOD_DISPLAY_ORDER.filter((method) => configured.has(method));
}
