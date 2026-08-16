import bcrypt from 'bcryptjs';
import { signToken } from '../../utils/jwt.js';
import { sendOtpEmail, sendResetEmail } from '../../utils/mailer.js';
import { logger } from '../../config/logger.js';
import * as repo from './auth.repo.js';
import { env } from '../../config/env.js';

export type RegisterResult = { ok: true; userId: string } | { conflict: true };

export async function registerUser(email: string, password: string, firstName: string, lastName: string): Promise<RegisterResult> {
  const existingUser = await repo.getUserByEmail(email);
  if (existingUser) return { conflict: true };

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  const user = await repo.createUser(email, passwordHash, firstName, lastName);
  if (!user) throw new Error('Failed to create user');

  await repo.verifyUser(user.id);
  logger.info({ email }, 'User registered and activated without verification email');

  return { ok: true, userId: user.id };
}

export type VerifyResult = { ok: true } | { notFound: true } | { invalid: true } | { used: true } | { expired: true };

export async function verifyEmailOtp(email: string, code: string): Promise<VerifyResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) return { notFound: true };
  
  const otps = await repo.getUnusedOtpsForUser(user.id, 'verify_email');
  for (const otp of otps) {
    const ok = await bcrypt.compare(code, otp.otp_hash);
    if (ok) {
      await repo.markOtpAsUsed(otp.id);
      await repo.verifyUser(user.id);
      logger.info({ email }, 'Email OTP verified');
      return { ok: true };
    } else {
      await repo.incrementOtpAttempts(otp.id);
    }
  }
  
  return { invalid: true };
}

export type LoginResult = { ok: true; token: string; refreshToken: string; user: { id: string; email: string; firstName: string | null; lastName: string | null; role: 'user' | 'admin' } } | { invalid: true } | { unverified: true };

export async function loginUser(email: string, password: string, options?: { userAgent?: string | null; ipAddress?: string | null }): Promise<LoginResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) return { invalid: true };

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return { invalid: true };

  if (!user.verified_at) return { unverified: true };

  const token = signToken({ sub: user.id, email, tv: user.token_version });
  const { token: refreshToken } = await repo.createRefreshToken(user.id, {
    userAgent: options?.userAgent ?? null,
    ipAddress: options?.ipAddress ?? null,
  });

  return {
    ok: true, 
    token, 
    refreshToken, 
    user: { 
      id: user.id, 
      email, 
      firstName: user.first_name, 
      lastName: user.last_name, 
      role: user.role 
    } 
  };
}

export type RefreshResult = { ok: true; token: string; refreshToken: string; user: { id: string; email: string; firstName: string | null; lastName: string | null; role: 'user' | 'admin' } } | { invalid: true } | { expired: true };

export async function refreshAccessToken(rawToken: string, options?: { userAgent?: string | null; ipAddress?: string | null }): Promise<RefreshResult> {
  const parts = String(rawToken).split('.');
  if (parts.length !== 2) return { invalid: true };
  const [selector, validator] = parts;
  if (!selector || !validator) return { invalid: true };

  const rotated = await repo.rotateRefreshToken(selector, validator, {
    userAgent: options?.userAgent ?? null,
    ipAddress: options?.ipAddress ?? null,
  });
  if (rotated.status === 'invalid') return { invalid: true };
  if (rotated.status === 'expired') return { expired: true };

  const user = await repo.getUserById(rotated.userId);
  if (!user) return { invalid: true };
  const token = signToken({ sub: user.id, email: user.email, tv: user.token_version });

  return {
    ok: true, 
    token, 
    refreshToken: rotated.refreshToken,
    user: { 
      id: user.id, 
      email: user.email, 
      firstName: user.first_name, 
      lastName: user.last_name, 
      role: user.role 
    } 
  };
}

export async function logout(rawToken?: string) {
  if (!rawToken) return;
  const parts = String(rawToken).split('.');
  if (parts.length === 2 && parts[0]) {
    await repo.revokeRefreshTokenBySelector(parts[0]);
  }
}

export async function logoutAll(userId: string) {
  await repo.revokeAllRefreshTokensForUser(userId);
  await repo.incrementTokenVersion(userId);
}

export type ResendOtpResult = { ok: true } | { alreadyVerified: true };

export async function resendOtp(email: string, purpose: 'verify' | 'password_reset'): Promise<ResendOtpResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) return { ok: true };
  
  if (purpose === 'verify' && user.verified_at) return { alreadyVerified: true };
  
  const code = await repo.issueOtp(user.id, purpose === 'verify' ? 'verify_email' : 'password_reset', null);
  
  if (purpose === 'verify') {
    await sendOtpEmail(email, code);
  } else {
    await sendResetEmail(email, code);
  }
  
  logger.info({ email, purpose }, `${purpose === 'verify' ? 'Verification' : 'Password reset'} OTP re-sent`);
  return { ok: true };
}

export async function createPasswordResetOtp(email: string) {
  const user = await repo.getUserByEmail(email);
  if (!user) return;
  
  const code = await repo.issueOtp(user.id, 'password_reset', null);
  await sendResetEmail(email, code);
  logger.info({ email }, 'Password reset OTP generated');
}

export type ResetPasswordResult = { ok: true } | { invalid: true } | { expired: true };

export async function resetPasswordWithOtp(email: string, code: string, password: string): Promise<ResetPasswordResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) return { invalid: true };
  
  const otps = await repo.getUnusedOtpsForUser(user.id, 'password_reset');
  for (const otp of otps) {
    const ok = await bcrypt.compare(code, otp.otp_hash);
    if (ok) {
      await repo.markOtpAsUsed(otp.id);
      const hash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
      await repo.resetPasswordAndRevokeSessions(user.id, hash);
      logger.info({ email }, 'Password reset with OTP');
      return { ok: true };
    } else {
      await repo.incrementOtpAttempts(otp.id);
    }
  }
  
  return { invalid: true };
}

export async function getCurrentUser(userId: string) {
  return repo.getUserById(userId);
}

export async function updateCurrentUser(
  userId: string,
  input: { firstName?: string | undefined; lastName?: string | undefined }
) {
  return repo.updateUserProfile(userId, input);
}
