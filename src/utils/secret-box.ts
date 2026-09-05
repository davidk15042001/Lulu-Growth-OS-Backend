import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** Key resolution is isolated here so a future secret manager need not change callers. */
export function createSecretBox(config: { currentKey?: string | undefined; version: string; previousKeys?: Record<string, string> | undefined; legacySecret: string }) {
  const legacyKey = crypto.createHash('sha256').update(config.legacySecret, 'utf8').digest();
  const keys = new Map<string, Buffer>();
  for (const [version, material] of Object.entries(config.previousKeys ?? {})) {
    if (!/^[\w-]{1,32}$/.test(version) || !/^[a-fA-F0-9]{64}$/.test(material)) throw new Error('Invalid provider credential key configuration');
    keys.set(version, Buffer.from(material, 'hex'));
  }
  if (config.currentKey) {
    if (!/^[\w-]{1,32}$/.test(config.version) || !/^[a-fA-F0-9]{64}$/.test(config.currentKey)) throw new Error('Invalid provider credential key configuration');
    const current = Buffer.from(config.currentKey, 'hex');
    if (crypto.timingSafeEqual(current, legacyKey) || config.currentKey === config.legacySecret) throw new Error('Provider and authentication keys must be independent');
    if (keys.has(config.version) && !keys.get(config.version)!.equals(current)) throw new Error('Conflicting provider credential key version');
    keys.set(config.version, current);
  }
  function encrypt(value: string) {
    const key = config.currentKey ? keys.get(config.version) : undefined;
    if (!key) throw new Error('PROVIDER_CREDENTIAL_KEY must be configured before storing provider credentials');
    const header = `v2.${config.version}`;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(header));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [header, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }
  function decrypt(payload: string) {
    try {
      const parts = payload.split('.');
      const legacy = parts[0] === 'v1' && parts.length === 4;
      if (!legacy && !(parts[0] === 'v2' && parts.length === 5)) throw new Error();
      const key = legacy ? legacyKey : keys.get(parts[1]!);
      if (!key) throw new Error();
      const offset = legacy ? 1 : 2;
      const iv = Buffer.from(parts[offset]!, 'base64url');
      const tag = Buffer.from(parts[offset + 1]!, 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      if (!legacy) decipher.setAAD(Buffer.from(`v2.${parts[1]}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(parts[offset + 2]!, 'base64url')), decipher.final()]).toString('utf8');
    } catch { throw new Error('Provider credential could not be decrypted'); }
  }
  return { encrypt, decrypt, needsRotation: (value: string) => Boolean(config.currentKey) && !value.startsWith(`v2.${config.version}.`) };
}

function configuredBox() {
  let previousKeys: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(env.PROVIDER_CREDENTIAL_PREVIOUS_KEYS ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string')) throw new Error();
    previousKeys = parsed as Record<string,string>;
  } catch { throw new Error('Invalid provider credential previous-key configuration'); }
  return createSecretBox({ currentKey: env.PROVIDER_CREDENTIAL_KEY, version: env.PROVIDER_CREDENTIAL_KEY_VERSION, previousKeys,
    legacySecret: env.PROVIDER_CREDENTIAL_LEGACY_KEY ?? env.JWT_SECRET });
}
export const encryptSecret = (value: string) => configuredBox().encrypt(value);
export const decryptSecret = (value: string) => configuredBox().decrypt(value);
export const secretNeedsRotation = (value: string) => configuredBox().needsRotation(value);
