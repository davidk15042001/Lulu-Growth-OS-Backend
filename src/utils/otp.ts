import * as crypto from 'crypto';

export function generateOtp(length = 6): string {
  const max = 10 ** length;
  const code = crypto.randomInt(0, max).toString().padStart(length, '0');
  return code;
}

export function hashOtp(code: string): string {
  return crypto.createHash('sha256').update(code.trim()).digest('hex');
}

export function verifyOtpHash(code: string, storedHash: string): boolean {
  const computed = hashOtp(code);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
