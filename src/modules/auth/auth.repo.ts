import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from '../../db/pool.js';

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
    [email, passwordHash, firstName, lastName]
  );
  return rows[0];
}

export async function getUserByEmail(email: string) {
  const { rows } = await query<{ id: string; password_hash: string; verified_at: string | null; token_version: number; first_name: string | null; last_name: string | null; role: 'user' | 'admin' }>(
    'SELECT id, password_hash, verified_at, token_version, first_name, last_name, role FROM users WHERE email=$1',
    [email]
  );
  return rows[0];
}

export async function getUserById(id: string) {
  const { rows } = await query<{ id: string; email: string; token_version: number; first_name: string | null; last_name: string | null; role: 'user' | 'admin' }>(
    'SELECT id, email, token_version, first_name, last_name, role FROM users WHERE id=$1',
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

export async function incrementTokenVersion(id: string) {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [id]);
}

export async function createRefreshToken(userId: string, options?: { userAgent?: string | null; ipAddress?: string | null }) {
  const selector = genSelector();
  const validator = genValidator();
  const rawToken = `${selector}.${validator}`;
  const hash = await bcrypt.hash(validator, 12);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  
  await query(
    'INSERT INTO refresh_tokens(selector, token_hash, user_id, expires_at, user_agent, ip_address, created_at, last_used_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())',
    [selector, hash, userId, expiresAt, options?.userAgent || null, options?.ipAddress || null]
  );
  
  return { token: rawToken, expiresAt };
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
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const hash = await bcrypt.hash(code, 12);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  
  await query(
    'INSERT INTO otp_codes(user_id, otp_hash, purpose, expires_at, ip_address) VALUES($1,$2,$3,$4,$5)',
    [userId, hash, purpose, expiresAt, ipAddress]
  );
  
  return code;
}

export async function getUnusedOtpsForUser(userId: string, purpose: string) {
  const { rows } = await query<OtpCode>(
    'SELECT * FROM otp_codes WHERE user_id = $1 AND purpose=$2 AND used=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 3',
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
