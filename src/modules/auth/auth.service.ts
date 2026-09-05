import bcrypt from 'bcryptjs';
import { signToken } from '../../utils/jwt.js';
import { sendOtpEmail, sendResetEmail } from '../../utils/mailer.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertAdminCapability, getAdminCapabilities } from '../admin/admin.authorization.js';
import * as repo from './auth.repo.js';
import { env } from '../../config/env.js';

export type RegisterResult = { ok: true; userId: string; verificationSent: boolean } | { conflict: true };
type SessionUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'user' | 'admin';
  impersonation: { active: boolean; adminEmail: string | null };
};
type SessionActor = repo.ImpersonationActor;

async function buildSessionUser(
  user: { id: string; email: string; first_name: string | null; last_name: string | null; role: 'user' | 'admin' },
  impersonator?: SessionActor | null,
): Promise<SessionUser & { adminCapabilities: string[] }> {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    role: user.role,
    adminCapabilities: impersonator ? [] : await getAdminCapabilities(user.id),
    impersonation: {
      active: Boolean(impersonator),
      adminEmail: impersonator?.email ?? null,
    },
  };
}

function signSessionToken(
  user: { id: string; email: string },
  tokenVersion: number,
  sessionId: string,
  impersonator?: SessionActor | null,
) {
  return signToken({
    sub: user.id,
    email: user.email,
    tv: tokenVersion,
    sid: sessionId,
    ...(impersonator ? {
      impersonatorUserId: impersonator.userId,
      impersonatorEmail: impersonator.email,
    } : {}),
  });
}

export async function registerUser(email: string, password: string, firstName: string, lastName: string): Promise<RegisterResult> {
  const existingUser = await repo.getUserByEmail(email);
  if (existingUser) return { conflict: true };

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  let user;
  try { user = await repo.createUnverifiedUser(email, passwordHash, firstName, lastName); }
  catch(error) { if((error as {code?:string}).code==='23505') return {conflict:true}; throw error; }
  // Commit account + challenge atomically before sending. Delivery failure leaves
  // a recoverable unverified account; resend never grants workspace access.
  let verificationSent=true;
  try {
    await sendOtpEmail(email,user.code);
    await recordSecurityEvent({eventType:'EMAIL_VERIFICATION_SENT',userId:user.id,metadata:{reason:'verification'}});
  }
  catch { verificationSent=false; await recordSecurityEvent({eventType:'EMAIL_DELIVERY_FAILED',userId:user.id,metadata:{reason:'verification'}}); }
  return { ok: true, userId: user.id, verificationSent };
}

export type VerifyResult = { ok: true } | { alreadyVerified:true } | { invalid: true } | { used: true } | { expired: true };

export async function verifyEmailOtp(email: string, code: string): Promise<VerifyResult> {
  return repo.consumeOtp(email,code,'verify_email');
}

export type LoginResult = { ok: true; token: string; refreshToken: string; user: SessionUser } | { invalid: true } | { unverified: true };

export async function loginUser(email: string, password: string, options?: { userAgent?: string | null; ipAddress?: string | null }): Promise<LoginResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) { await recordSecurityEvent({eventType:'LOGIN_FAILURE',metadata:{reason:'invalid_credentials'}}); return { invalid: true }; }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) { await recordSecurityEvent({eventType:'LOGIN_FAILURE',userId:user.id,metadata:{reason:'invalid_credentials'}}); return { invalid: true }; }

  if (!user.verified_at) {
    await recordSecurityEvent({eventType:'LOGIN_FAILURE',userId:user.id,metadata:{reason:'unverified'}});
    return {unverified:true};
  }

  const session = await repo.createAdditionalSession(user.id, {
    userAgent: options?.userAgent ?? null,
    ipAddress: options?.ipAddress ?? null,
  });
  const token = signSessionToken({ id: user.id, email }, session.tokenVersion, session.sessionId);
  await recordSecurityEvent({eventType:'LOGIN_SUCCESS',userId:user.id,metadata:{sessionId:session.sessionId}});
  const refreshToken = session.token;

  return {
    ok: true, 
    token, 
    refreshToken, 
    user: await buildSessionUser({ ...user, email })
  };
}

export type RefreshResult = { ok: true; token: string; refreshToken: string; user: SessionUser } | { invalid: true } | { expired: true } | {reused:true};

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
  if (rotated.status === 'reused') return { reused: true };

  const user = await repo.getUserById(rotated.userId);
  if (!user) return { invalid: true };
  if(rotated.impersonator) await assertAdminCapability(rotated.impersonator.userId,'users.impersonate');
  const token = signSessionToken({ id: user.id, email: user.email }, user.token_version, rotated.sessionId, rotated.impersonator);

  return {
    ok: true, 
    token, 
    refreshToken: rotated.refreshToken,
    user: await buildSessionUser(user, rotated.impersonator)
  };
}

export type ImpersonationResult =
  | { ok: true; token: string; refreshToken: string; user: SessionUser }
  | { notFound: true }
  | { invalidTarget: true };

export async function impersonateUser(
  actor: SessionActor,
  targetUserId: string,
  options?: { userAgent?: string | null; ipAddress?: string | null },
): Promise<ImpersonationResult> {
  await assertAdminCapability(actor.userId,'users.impersonate');
  if (!targetUserId || actor.userId === targetUserId) return { invalidTarget: true };

  const user = await repo.getUserById(targetUserId);
  if (!user) return { notFound: true };
  if (user.role === 'admin') return { invalidTarget: true };

  const session = await repo.createAdditionalSession(user.id, {
    userAgent: options?.userAgent ?? null,
    ipAddress: options?.ipAddress ?? null,
    impersonator: actor,
  });

  return {
    ok: true,
    token: signSessionToken({ id: user.id, email: user.email }, session.tokenVersion, session.sessionId, actor),
    refreshToken: session.token,
    user: await buildSessionUser(user, actor),
  };
}

export type StopImpersonationResult =
  | { ok: true; token: string; refreshToken: string; user: SessionUser }
  | { invalid: true };

export async function stopImpersonation(
  actor: SessionActor,
  options?: { userAgent?: string | null; ipAddress?: string | null },
): Promise<StopImpersonationResult> {
  await assertAdminCapability(actor.userId,'users.impersonate');
  const admin = await repo.getUserById(actor.userId);
  if (!admin || admin.role !== 'admin' || admin.email.trim().toLowerCase() !== actor.email.trim().toLowerCase()) {
    return { invalid: true };
  }

  const session = await repo.createAdditionalSession(admin.id, {
    userAgent: options?.userAgent ?? null,
    ipAddress: options?.ipAddress ?? null,
  });

  return {
    ok: true,
    token: signSessionToken({ id: admin.id, email: admin.email }, session.tokenVersion, session.sessionId),
    refreshToken: session.token,
    user: await buildSessionUser(admin),
  };
}

export async function logout(rawToken?: string) {
  if (!rawToken) return;
  await repo.revokeRefreshToken(rawToken);
}

export async function logoutAll(userId: string) {
  await repo.revokeSessions(userId);
}

export type ResendOtpResult = { ok: true } | { alreadyVerified: true };

export async function resendOtp(email: string, purpose: 'verify' | 'password_reset'): Promise<ResendOtpResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) return { ok: true };
  
  if (purpose === 'verify' && user.verified_at) return { alreadyVerified: true };
  
  const code = await repo.issueOtp(user.id, purpose === 'verify' ? 'verify_email' : 'password_reset');
  if(!code) return {alreadyVerified:true};
  
  if (purpose === 'verify') {
    await sendOtpEmail(email, code);
    await recordSecurityEvent({eventType:'EMAIL_VERIFICATION_SENT',userId:user.id,metadata:{reason:'verify_resend'}});
  } else {
    await sendResetEmail(email, code);
  }
  
  return { ok: true };
}

export async function createPasswordResetOtp(email: string) {
  const user = await repo.getUserByEmail(email);
  if (!user) return;
  
  const code = await repo.issueOtp(user.id, 'password_reset');
  if(code) await sendResetEmail(email, code);
}

export type ResetPasswordResult = { ok: true } | { invalid: true } | { expired: true };

export async function resetPasswordWithOtp(email: string, code: string, password: string): Promise<ResetPasswordResult> {
  const result=await repo.consumeOtp(email,code,'password_reset',await bcrypt.hash(password,env.BCRYPT_ROUNDS));
  return 'ok' in result ? {ok:true} : 'expired' in result ? {expired:true} : {invalid:true};
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
