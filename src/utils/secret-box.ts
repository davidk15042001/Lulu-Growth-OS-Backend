import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function key() {
  return crypto.createHash('sha256').update(env.JWT_SECRET, 'utf8').digest();
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload: string) {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split('.');
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Unsupported encrypted secret format');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
}
