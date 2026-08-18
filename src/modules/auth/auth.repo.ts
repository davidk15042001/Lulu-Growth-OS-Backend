import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { generateOtp } from '../../utils/otp.js';
import type { PoolClient } from 'pg';

export interface RefreshToken {
  id: string;
  selector: string;
  token_hash: string;
  user_id: string;
  user_agent?: string;
  ip_address?: string;
  created_at: Date;
  last_used_at?: Date;
  expires_at: Date;
  revoked: boolean;
}

export interface OtpCode {
  id: string;
  user_id?: string;
  otp_hash: string;
  purpose: string;
  created_at: Date;
  expires_at: Date;
  used: boolean;
  ip_address?: string;
  attempts: number;
}

function genSelector(len = 12): string {
  return crypto.randomBytes(len).toString('hex');
}

function genValidator(len = 48): string {
  return crypto.randomBytes(len).toString('base64url');
}

export async function createUser(email: string, passwordHash: string, firstName: string, lastName: string) {
  const { rows } = await query<{ id: string }>(
    'INSERT INTO users(email, password_hash, first_name, last_name) VALUES($1,$2,$3,$4) RETURNING id',
    [email.toLowerCase(), passwordHash, firstName, lastName]
  );
  return rows[0];
}

export async function getUserByEmail(email: string) {
  const { rows } = await query<{ id: string; email: string; password_hash: string; verified_at: string | null; token_version: number; first_name: string | null; last_name: string | null; role: 'user' | 'admin' }>(
    'SELECT id, email, password_hash, verified_at, token_version, first_name, last_name, role FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL',
    [email.toLowerCase()]
  );
  return rows[0];
}

export async function getUserById(id: string) {
  const { rows } = await query<{ id: string; email: string; token_version: number; first_name: string | null; last_name: string | null; role: 'user' | 'admin' }>(
    'SELECT id, email, token_version, first_name, last_name, role FROM users WHERE id=$1 AND deleted_at IS NULL',
    [id]
  );
  return rows[0];
}

export async function verifyUser(id: string) {
  await query('UPDATE users SET verified_at=NOW() WHERE id=$1', [id]);
}

export async function updateUserPassword(id: string, passwordHash: string) {
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, id]);
}

export async function updateUserProfile(
  id: string,
  input: { firstName?: string | undefined; lastName?: string | undefined }
) {
  const values: unknown[] = [id];
  const assignments: string[] = [];
  if (input.firstName !== undefined) {
    values.push(input.firstName);
    assignments.push(`first_name = $${values.length}`);
  }
  if (input.lastName !== undefined) {
    values.push(input.lastName);
    assignments.push(`last_name = $${values.length}`);
  }
  await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = $1 AND deleted_at IS NULL`, values);
  return getUserById(id);
}

export async function incrementTokenVersion(id: string) {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [id]);
}

export async function createRefreshToken(
  userId: string,
  options?: { userAgent?: string | null; ipAddress?: string | null },
  client?: PoolClient
) {
  const selector = genSelector();
  const validator = genValidator();
  const rawToken = `${selector}.${validator}`;
  const hash = await bcrypt.hash(validator, env.BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  
  await query(
    'INSERT INTO refresh_tokens(selector, token_hash, user_id, expires_at, user_agent, ip_address, created_at, last_used_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())',
    [selector, hash, userId, expiresAt, options?.userAgent || null, options?.ipAddress || null],
    client
  );
  
  return { token: rawToken, expiresAt };
}

export async function createSingleDeviceSession(
  userId: string,
  options?: { userAgent?: string | null; ipAddress?: string | null },
) {
  return withTransaction(async (client) => {
    const { rows } = await query<{ token_version: number }>(
      `UPDATE users
       SET token_version = token_version + 1
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING token_version`,
      [userId],
      client,
    );
    if (!rows[0]) throw new Error('User not found while creating session');

    await query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE',
      [userId],
      client,
    );
    const refresh = await createRefreshToken(userId, options, client);
    return { ...refresh, tokenVersion: rows[0].token_version };
  });
}

export async function getRefreshTokenBySelector(selector: string) {
  const { rows } = await query<RefreshToken>(
    'SELECT * FROM refresh_tokens WHERE selector=$1 AND revoked=false LIMIT 1',
    [selector]
  );
  return rows[0];
}

export async function revokeRefreshTokenBySelector(selector: string) {
  await query('UPDATE refresh_tokens SET revoked=true WHERE selector=$1', [selector]);
}

export async function revokeAllRefreshTokensForUser(userId: string) {
  await query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [userId]);
}

export async function issueOtp(userId: string | null, purpose: string, ipAddress: string | null) {
  const code = generateOtp();
  const hash = await bcrypt.hash(code, env.BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000);

  return withTransaction(async (client) => {
    await query(
      `UPDATE otp_codes
       SET used = TRUE
       WHERE user_id = $1 AND purpose = $2 AND used = FALSE`,
      [userId, purpose],
      client
    );
    await query(
      'INSERT INTO otp_codes(user_id, otp_hash, purpose, expires_at, ip_address) VALUES($1,$2,$3,$4,$5)',
      [userId, hash, purpose, expiresAt, ipAddress],
      client
    );
    return code;
  });
}

export async function getUnusedOtpsForUser(userId: string, purpose: string) {
  const { rows } = await query<OtpCode>(
    'SELECT * FROM otp_codes WHERE user_id = $1 AND purpose=$2 AND used=false AND expires_at > NOW() AND attempts < 5 ORDER BY created_at DESC LIMIT 3',
    [userId, purpose]
  );
  return rows;
}

export async function markOtpAsUsed(id: string) {
  await query('UPDATE otp_codes SET used=true WHERE id=$1', [id]);
}

export async function incrementOtpAttempts(id: string) {
  await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [id]);
}

export async function rotateRefreshToken(
  selector: string,
  validator: string,
  options?: { userAgent?: string | null; ipAddress?: string | null }
) {
  return withTransaction(async (client) => {
    const { rows } = await query<RefreshToken>(
      `SELECT *
       FROM refresh_tokens
       WHERE selector = $1 AND revoked = FALSE
       LIMIT 1
       FOR UPDATE`,
      [selector],
      client
    );
    const current = rows[0];
    if (!current) return { status: 'invalid' as const };

    if (new Date(current.expires_at) <= new Date()) {
      await query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [current.id], client);
      return { status: 'expired' as const };
    }

    const valid = await bcrypt.compare(validator, current.token_hash);
    if (!valid) {
      await query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [current.id], client);
      return { status: 'invalid' as const };
    }

    await query(
      'UPDATE refresh_tokens SET revoked = TRUE, last_used_at = NOW() WHERE id = $1',
      [current.id],
      client
    );
    const next = await createRefreshToken(current.user_id, options, client);
    return { status: 'rotated' as const, userId: current.user_id, refreshToken: next.token };
  });
}

export async function resetPasswordAndRevokeSessions(userId: string, passwordHash: string) {
  await withTransaction(async (client) => {
    await query(
      `UPDATE users
       SET password_hash = $2, token_version = token_version + 1
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId, passwordHash],
      client
    );
    await query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE',
      [userId],
      client
    );
  });
}
