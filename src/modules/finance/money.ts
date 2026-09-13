import { AppError } from '../../utils/app-error.js';

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const FOUR_DECIMAL_CURRENCIES = new Set(['CLF', 'UYW']);

export function normalizeCurrency(currency: string) {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new AppError(422, 'INVALID_CURRENCY', 'Currency must be a three-letter ISO-4217 code');
  }
  return normalized;
}

export function currencyMinorDigits(currency: string) {
  const normalized = normalizeCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(normalized)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(normalized)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(normalized)) return 4;
  return 2;
}

function decimalParts(value: string | number) {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new AppError(422, 'INVALID_MONEY_AMOUNT', 'Money amounts must be non-negative decimal values');
  }
  const [whole = '0', fraction = ''] = raw.split('.');
  return { whole: whole.replace(/^0+(?=\d)/, ''), fraction };
}

/**
 * Converts a decimal major-unit amount without binary floating-point math.
 * Values finer than the ISO minor unit are rounded half-up and the caller can
 * retain the source amount in journal metadata for reconciliation.
 */
export function decimalToMinorUnits(value: string | number, currency: string) {
  const digits = currencyMinorDigits(currency);
  const { whole, fraction } = decimalParts(value);
  const kept = fraction.slice(0, digits).padEnd(digits, '0');
  const discarded = fraction.slice(digits);
  const factor = 10n ** BigInt(digits);
  let minor = (BigInt(whole) * factor) + BigInt(kept || '0');
  if (discarded.length > 0 && discarded[0]! >= '5') minor += 1n;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(422, 'MONEY_AMOUNT_TOO_LARGE', 'Money amount exceeds the safe operational ledger limit');
  }
  return Number(minor);
}

export function minorUnitsToDecimal(amountMinor: number, currency: string) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new AppError(422, 'INVALID_MONEY_AMOUNT', 'Minor-unit amount must be a non-negative safe integer');
  }
  const digits = currencyMinorDigits(currency);
  if (digits === 0) return String(amountMinor);
  const raw = String(amountMinor).padStart(digits + 1, '0');
  return `${raw.slice(0, -digits)}.${raw.slice(-digits)}`;
}
