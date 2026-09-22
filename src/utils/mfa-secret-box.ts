import crypto from 'node:crypto';
import { env } from '../config/env.js';

function key() {
  if (!env.MFA_SECRET_KEY) throw new Error('MFA_SECRET_KEY must be configured before enabling user MFA');
  return Buffer.from(env.MFA_SECRET_KEY, 'hex');
}

export function encryptMfaSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['mfa1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptMfaSecret(payload: string) {
  try {
    const [version, ivValue, tagValue, dataValue] = payload.split('.');
    if (version !== 'mfa1' || !ivValue || !tagValue || !dataValue) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataValue, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('MFA secret could not be decrypted');
  }
}
