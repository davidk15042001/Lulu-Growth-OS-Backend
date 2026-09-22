import bcrypt from 'bcryptjs';
import { signToken } from '../../utils/jwt.js';
import { sendAdminLoginOtpEmail, sendOtpEmail, sendResetEmail } from '../../utils/mailer.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertAdminCapability, getAdminCapabilities } from '../admin/admin.authorization.js';
import * as repo from './auth.repo.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ensureAgentMemoryUser } from '../agent-memory/agent-memory.service.js';
import { createRecoveryCodes, generateTotpSecret, totpSecretUri, verifyTotp } from '../../utils/totp.js';
import { decryptMfaSecret, encryptMfaSecret } from '../../utils/mfa-secret-box.js';
import { AppError } from '../../utils/app-error.js';

export type RegisterResult = { ok: true; userId: string; verificationRequired: false } | { conflict: true };
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
  try { user = await repo.createVerifiedUser(email, passwordHash, firstName, lastName); }
  catch(error) { if((error as {code?:string}).code==='23505') return {conflict:true}; throw error; }
  await ensureAgentMemoryUser({ userId: user.id, email, firstName, lastName });
  return { ok: true, userId: user.id, verificationRequired: false };
}

export type VerifyResult = { ok: true } | { alreadyVerified:true } | { invalid: true } | { used: true } | { expired: true };

export async function verifyEmailOtp(email: string, code: string): Promise<VerifyResult> {
  return repo.consumeOtp(email,code,'verify_email');
}

export type LoginResult = { ok: true; token: string; refreshToken: string; user: SessionUser } | { invalid: true } | { unverified: true } | { mfaRequired:true; email:string; challengeId?:string; method?:'totp' };

type LoginOptions={userAgent?:string|null;ipAddress?:string|null;sendAdminCode?:(email:string,code:string)=>Promise<void>};
async function createLoginSession(user: NonNullable<Awaited<ReturnType<typeof repo.getUserByEmail>>>, email:string, options?: LoginOptions):Promise<LoginResult> {
  if (user.role === 'user') await repo.ensureInitialWorkspace(user.id, user.first_name, user.last_name, user.email);
  const session = await repo.createAdditionalSession(user.id, {userAgent:options?.userAgent??null,ipAddress:options?.ipAddress??null});
  const token = signSessionToken({ id: user.id, email }, session.tokenVersion, session.sessionId);
  await recordSecurityEvent({eventType:'LOGIN_SUCCESS',userId:user.id,metadata:{sessionId:session.sessionId,mfa:user.role==='admin'}});
  return {ok:true,token,refreshToken:session.token,user:await buildSessionUser({...user,email})};
}

export async function loginUser(email: string, password: string, options?: LoginOptions): Promise<LoginResult> {
  const user = await repo.getUserByEmail(email);
  if (!user) { await recordSecurityEvent({eventType:'LOGIN_FAILURE',metadata:{reason:'invalid_credentials'}}); return { invalid: true }; }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) { await recordSecurityEvent({eventType:'LOGIN_FAILURE',userId:user.id,metadata:{reason:'invalid_credentials'}}); return { invalid: true }; }

  // Registration no longer requires email ownership verification. Existing
  // accounts created by older releases may still have a null verified_at;
  // promote them on their first successful password login so they are not
  // stranded behind the retired email-OTP gate.
  if (!user.verified_at) {
    await repo.markUserVerified(user.id);
  }

  if(user.role==='admin' && env.ADMIN_MFA_ENABLED) {
    const code=await repo.issueOtp(user.id,'login');
    if(!code) return {invalid:true};
    await (options?.sendAdminCode??sendAdminLoginOtpEmail)(user.email,code);
    await recordSecurityEvent({eventType:'ADMIN_MFA_CHALLENGE_ISSUED',userId:user.id});
    return {mfaRequired:true,email:user.email};
  }

  if (user.mfa_enabled) {
    const challenge = await repo.createMfaChallenge(user.id);
    await recordSecurityEvent({ eventType: 'MFA_CHALLENGE_ISSUED', userId: user.id, metadata: { challengeId: challenge.id } });
    return { mfaRequired: true, email: user.email, challengeId: challenge.id, method: 'totp' };
  }

  return createLoginSession(user,email,options);
}

export async function completeUserMfaLogin(challengeId: string, code: string, options?: { userAgent?: string | null; ipAddress?: string | null }) {
  const challenge = await repo.getMfaChallenge(challengeId);
  if (!challenge || challenge.usedAt || new Date(challenge.expiresAt).getTime() <= Date.now()) return { invalidMfa: true } as const;
  const stored = await repo.getMfaSecretAndRecoveryCodes(challenge.userId);
  if (!stored?.secretEncrypted) return { invalidMfa: true } as const;
  let valid = false;
  let usedRecoveryIndex: number | null = null;
  try {
    valid = verifyTotp(decryptMfaSecret(stored.secretEncrypted), code);
  } catch {
    valid = false;
  }
  if (!valid) {
    for (let index = 0; index < stored.recoveryCodeHashes.length; index += 1) {
      if (await bcrypt.compare(code.trim().toUpperCase(), stored.recoveryCodeHashes[index]!)) {
        valid = true;
        usedRecoveryIndex = index;
        break;
      }
    }
  }
  if (!valid || !await repo.consumeMfaChallenge(challengeId, challenge.userId)) {
    await recordSecurityEvent({ eventType: 'MFA_CHALLENGE_FAILED', userId: challenge.userId, metadata: { challengeId } });
    return { invalidMfa: true } as const;
  }
  if (usedRecoveryIndex !== null) await repo.consumeRecoveryCode(challenge.userId, usedRecoveryIndex);
  const user = await repo.getUserById(challenge.userId);
  if (!user) return { invalidMfa: true } as const;
  await recordSecurityEvent({ eventType: 'MFA_CHALLENGE_COMPLETED', userId: user.id, metadata: { challengeId, recoveryCode: usedRecoveryIndex !== null } });
  const session = await createLoginSession(user, user.email, options);
  return 'ok' in session ? session : { invalidMfa: true } as const;
}

export async function getMfaStatus(userId: string) {
  const state = await repo.getMfaState(userId);
  return { enabled: state.enabled, setupAvailable: Boolean(env.MFA_SECRET_KEY), pendingSetup: Boolean(await repo.getMfaSetup(userId)) };
}

export async function startMfaSetup(userId: string) {
  if (!env.MFA_SECRET_KEY) throw new AppError(503, 'MFA_NOT_CONFIGURED', 'Customer MFA is not configured on this server.');
  const state = await repo.getMfaState(userId);
  if (state.enabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled for this account.');
  const user = await repo.getUserById(userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  const secret = generateTotpSecret();
  const setup = await repo.saveMfaSetup(userId, encryptMfaSecret(secret));
  return { secret, otpauthUri: totpSecretUri(secret, user.email), expiresAt: setup.expiresAt };
}

export async function confirmMfaSetup(userId: string, code: string) {
  const setup = await repo.getMfaSetup(userId);
  if (!setup) throw new AppError(409, 'MFA_SETUP_EXPIRED', 'MFA setup has expired. Start setup again.');
  if (!verifyTotp(decryptMfaSecret(setup.secretEncrypted), code)) throw new AppError(400, 'MFA_CODE_INVALID', 'The authenticator code is invalid.');
  const recoveryCodes = createRecoveryCodes();
  const hashes = await Promise.all(recoveryCodes.map((value) => bcrypt.hash(value, env.BCRYPT_ROUNDS)));
  await repo.enableMfa(userId, setup.secretEncrypted, hashes);
  await recordSecurityEvent({ eventType: 'MFA_ENABLED', userId });
  return { enabled: true, recoveryCodes };
}

export async function disableUserMfa(userId: string, password: string, code: string) {
  const user = await repo.getUserById(userId);
  if (!user || !await bcrypt.compare(password, user.password_hash)) throw new AppError(400, 'MFA_PASSWORD_INVALID', 'The account password is invalid.');
  const stored = await repo.getMfaSecretAndRecoveryCodes(userId);
  if (!stored?.secretEncrypted) throw new AppError(409, 'MFA_NOT_ENABLED', 'MFA is not enabled for this account.');
  let valid = false;
  try { valid = verifyTotp(decryptMfaSecret(stored.secretEncrypted), code); } catch { valid = false; }
  if (!valid) {
    for (let index = 0; index < stored.recoveryCodeHashes.length; index += 1) {
      if (await bcrypt.compare(code.trim().toUpperCase(), stored.recoveryCodeHashes[index]!)) {
        valid = true;
        await repo.consumeRecoveryCode(userId, index);
        break;
      }
    }
  }
  if (!valid) throw new AppError(400, 'MFA_CODE_INVALID', 'The authenticator or recovery code is invalid.');
  await repo.disableMfa(userId);
  await recordSecurityEvent({ eventType: 'MFA_DISABLED', userId });
  return { enabled: false, requiresReauthentication: true };
}

export async function completeAdminLogin(email:string,code:string,options?:{userAgent?:string|null;ipAddress?:string|null}):Promise<LoginResult|{invalidMfa:true}> {
  const user=await repo.getUserByEmail(email);
  if(!user||user.role!=='admin'||!user.verified_at)return {invalidMfa:true};
  const result=await repo.consumeOtp(email,code,'login');
  if(!('ok' in result)) {
    await recordSecurityEvent({eventType:'ADMIN_MFA_CHALLENGE_FAILED',userId:user.id,metadata:{reason:'expired' in result?'expired':'invalid'}});
    return {invalidMfa:true};
  }
  await recordSecurityEvent({eventType:'ADMIN_MFA_CHALLENGE_COMPLETED',userId:user.id});
  return createLoginSession(user,user.email,options);
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

export type ChangePasswordResult =
  | { ok: true }
  | { notFound: true }
  | { invalidCurrentPassword: true }
  | { samePassword: true };

export async function changeCurrentUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const user = await repo.getUserById(userId);
  if (!user) return { notFound: true };
  if (!await bcrypt.compare(currentPassword, user.password_hash)) {
    return { invalidCurrentPassword: true };
  }
  if (await bcrypt.compare(newPassword, user.password_hash)) {
    return { samePassword: true };
  }
  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  const changed = await repo.changeUserPassword(userId, passwordHash);
  if (!changed) return { notFound: true };
  // The password update and session revocation have already committed at this
  // point. Keep an audit-storage outage from turning that successful operation
  // into a misleading error response.
  try {
    await recordSecurityEvent({ eventType: 'PASSWORD_CHANGED', userId });
  } catch (error) {
    logger.error({ error, userId }, 'Password changed but audit event could not be persisted');
  }
  return { ok: true };
}
