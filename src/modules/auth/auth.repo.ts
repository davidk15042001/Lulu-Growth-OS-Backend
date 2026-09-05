import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { generateOtp } from '../../utils/otp.js';
import { AppError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';

export type ImpersonationActor = { userId: string; email: string };
export type SessionOptions = { userAgent?: string | null; ipAddress?: string | null; impersonator?: ImpersonationActor | null };
type User = { id: string; email: string; password_hash: string; verified_at: string | null; token_version: number; first_name: string | null; last_name: string | null; role: 'user' | 'admin' };
const userColumns = 'id,email,password_hash,verified_at,token_version,first_name,last_name,role';
export async function getUserByEmail(email: string) {
  return (await query<User>(`SELECT ${userColumns} FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL`,[email])).rows[0];
}
export async function getUserById(id: string) {
  return (await query<User>(`SELECT ${userColumns} FROM users WHERE id=$1 AND deleted_at IS NULL`,[id])).rows[0];
}
export async function updateUserProfile(id: string, input: { firstName?: string | undefined; lastName?: string | undefined }) {
  await query('UPDATE users SET first_name=COALESCE($2,first_name),last_name=COALESCE($3,last_name) WHERE id=$1 AND deleted_at IS NULL',[id,input.firstName ?? null,input.lastName ?? null]);
  return getUserById(id);
}
async function insertOtp(userId: string, purpose: string, client: PoolClient) {
  const code=generateOtp();
  const hash=await bcrypt.hash(code,env.BCRYPT_ROUNDS);
  await query('UPDATE otp_codes SET used=TRUE WHERE user_id=$1 AND purpose=$2 AND used=FALSE',[userId,purpose],client);
  await query(`INSERT INTO otp_codes(user_id,otp_hash,purpose,expires_at) VALUES($1,$2,$3,$4)`,
    [userId,hash,purpose,new Date(Date.now()+env.OTP_TTL_MINUTES*60_000)],client);
  await recordSecurityEvent({eventType:'EMAIL_VERIFICATION_ISSUED',userId,metadata:{reason:purpose}},client);
  return code;
}
export async function createUnverifiedUser(email: string, passwordHash: string, firstName: string, lastName: string) {
  return withTransaction(async client=>{
    const user=(await query<{id:string}>('INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,$2,$3,$4) RETURNING id',[email.toLowerCase(),passwordHash,firstName,lastName],client)).rows[0]!;
    const code=await insertOtp(user.id,'verify_email',client);
    return {id:user.id,code};
  });
}
export async function issueOtp(userId: string, purpose: 'verify_email'|'password_reset') {
  return withTransaction(async client=>{
    const user=(await query<User>(`SELECT ${userColumns} FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[userId],client)).rows[0];
    if (!user || (purpose==='verify_email' && user.verified_at)) return null;
    const recent=(await query(`SELECT id FROM otp_codes WHERE user_id=$1 AND purpose=$2 AND created_at>NOW()-INTERVAL '60 seconds' LIMIT 1`,[userId,purpose],client)).rows[0];
    if(recent) throw new AppError(429,'OTP_RESEND_RATE_LIMITED','Please wait 60 seconds before requesting another code');
    return insertOtp(userId,purpose,client);
  });
}
export async function consumeOtp(email: string, code: string, purpose: 'verify_email'|'password_reset', passwordHash?: string) {
  return withTransaction(async client=>{
    const user=(await query<User>(`SELECT ${userColumns} FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL FOR UPDATE`,[email],client)).rows[0];
    if(!user) return {invalid:true} as const;
    const otp=(await query<{id:string;otp_hash:string;used:boolean;expires_at:string;attempts:number}>(
      'SELECT id,otp_hash,used,expires_at,attempts FROM otp_codes WHERE user_id=$1 AND purpose=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',[user.id,purpose],client)).rows[0];
    const fail=async <T extends Record<string,boolean>>(result:T,reason:string)=>{
      await recordSecurityEvent({eventType:'EMAIL_VERIFICATION_FAILED',userId:user.id,metadata:{reason}},client); return result;
    };
    if(purpose==='verify_email' && user.verified_at) {
      if(otp?.used && await bcrypt.compare(code,otp.otp_hash)) return fail({used:true} as const,'used');
      return {alreadyVerified:true} as const;
    }
    if(!otp) return fail({invalid:true} as const,'invalid');
    if(otp.used) return fail({used:true} as const,'used');
    if(new Date(otp.expires_at).getTime()<=Date.now()) return fail({expired:true} as const,'expired');
    if(otp.attempts>=5) return fail({invalid:true} as const,'attempt_limit');
    if(!await bcrypt.compare(code,otp.otp_hash)) {
      await query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1',[otp.id],client);
      return fail({invalid:true} as const,'invalid');
    }
    await query('UPDATE otp_codes SET used=TRUE WHERE id=$1',[otp.id],client);
    if(purpose==='verify_email') {
      await query('UPDATE users SET verified_at=NOW() WHERE id=$1',[user.id],client);
      await recordSecurityEvent({eventType:'EMAIL_VERIFIED',userId:user.id},client);
    } else {
      if(!passwordHash) throw new Error('Password hash required');
      await query('UPDATE users SET password_hash=$2,token_version=token_version+1 WHERE id=$1',[user.id,passwordHash],client);
      await revokeSessionsInTransaction(user.id,null,'password_reset',client);
    }
    return {ok:true} as const;
  });
}

export function sessionDeviceLabel(userAgent?:string|null) {
  // Coarse label only: no raw UA, IP, device identifier or fingerprint retained.
  return /Edg\//.test(userAgent??'')?'Edge':/Firefox\//.test(userAgent??'')?'Firefox':/Chrome\//.test(userAgent??'')?'Chrome':/Safari\//.test(userAgent??'')?'Safari':'Browser';
}
async function insertRefresh(userId:string,sessionId:string,expiresAt:Date,impersonator:ImpersonationActor|null,client:PoolClient) {
  const selector=crypto.randomBytes(12).toString('hex');
  const validator=crypto.randomBytes(48).toString('base64url');
  await query(`INSERT INTO refresh_tokens(selector,token_hash,user_id,session_id,expires_at,impersonated_by_user_id,impersonated_by_email,last_used_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,NOW())`,[selector,await bcrypt.hash(validator,env.BCRYPT_ROUNDS),userId,sessionId,expiresAt,impersonator?.userId??null,impersonator?.email??null],client);
  return `${selector}.${validator}`;
}
export async function createAdditionalSession(userId:string,options:SessionOptions={}) {
  return withTransaction(async client=>{
    const user=(await query<User>(`SELECT ${userColumns} FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[userId],client)).rows[0];
    if(!user?.verified_at) throw new AppError(403,'ACCOUNT_UNVERIFIED','Verify your email to continue');
    const expiresAt=new Date(Date.now()+env.REFRESH_TOKEN_TTL_DAYS*86_400_000);
    const session=(await query<{id:string}>(`INSERT INTO auth_sessions(user_id,expires_at,device_label,impersonated_by_user_id) VALUES($1,$2,$3,$4) RETURNING id`,[userId,expiresAt,sessionDeviceLabel(options.userAgent),options.impersonator?.userId??null],client)).rows[0]!;
    const token=await insertRefresh(userId,session.id,expiresAt,options.impersonator??null,client);
    await recordSecurityEvent({eventType:'SESSION_CREATED',userId,metadata:{sessionId:session.id}},client);
    return {token,expiresAt,sessionId:session.id,tokenVersion:user.token_version};
  });
}
async function revokeSessionInTransaction(userId:string,sessionId:string,reason:string,client:PoolClient) {
  const result=await query(`UPDATE auth_sessions SET revoked_at=NOW(),revocation_reason=$3 WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`,[userId,sessionId,reason],client);
  await query('UPDATE refresh_tokens SET revoked=TRUE,revocation_reason=$3 WHERE user_id=$1 AND session_id=$2',[userId,sessionId,reason],client);
  if(result.rowCount) await recordSecurityEvent({eventType:'SESSION_REVOKED',userId,metadata:{sessionId,reason}},client);
  return result.rowCount>0;
}
export async function revokeSessionsInTransaction(userId:string,exceptId:string|null,reason:string,client:PoolClient) {
  const rows=(await query<{id:string}>('SELECT id FROM auth_sessions WHERE (user_id=$1 OR impersonated_by_user_id=$1) AND ($2::uuid IS NULL OR id<>$2) AND revoked_at IS NULL FOR UPDATE',[userId,exceptId],client)).rows;
  for(const row of rows) {
    await query('UPDATE auth_sessions SET revoked_at=NOW(),revocation_reason=$2 WHERE id=$1',[row.id,reason],client);
    await query('UPDATE refresh_tokens SET revoked=TRUE,revocation_reason=$2 WHERE session_id=$1',[row.id,reason],client);
    await recordSecurityEvent({eventType:'SESSION_REVOKED',userId,metadata:{sessionId:row.id,reason}},client);
  }
  return rows.length;
}
export async function revokeSession(userId:string,sessionId:string) {
  return withTransaction(client=>revokeSessionInTransaction(userId,sessionId,'user_revoked',client));
}
export async function revokeSessions(userId:string,exceptId:string|null=null) {
  return withTransaction(client=>revokeSessionsInTransaction(userId,exceptId,exceptId?'other_sessions_revoked':'logout_all',client));
}
export async function listSessions(userId:string,currentId:string) {
  return (await query(`SELECT id,created_at AS "createdAt",last_used_at AS "lastUsedAt",expires_at AS "expiresAt",device_label AS "deviceLabel",(id=$2) AS current
    FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW() AND impersonated_by_user_id IS NULL ORDER BY last_used_at DESC`,[userId,currentId])).rows;
}
export async function rotateRefreshToken(selector:string,validator:string,_options?:SessionOptions) {
  return withTransaction(async client=>{
    // Authenticate before revocation: knowledge of a selector alone cannot revoke.
    const current=(await query<{id:string;user_id:string;session_id:string;token_hash:string;revoked:boolean;rotated_at:string|null;expires_at:string;impersonated_by_user_id:string|null;impersonated_by_email:string|null}>(
      'SELECT * FROM refresh_tokens WHERE selector=$1',[selector],client)).rows[0];
    if(!current || !await bcrypt.compare(validator,current.token_hash)) return {status:'invalid'} as const;
    // The session row serializes rotations and revocations for the entire family.
    const session=(await query<{expires_at:string;revoked_at:string|null}>('SELECT expires_at,revoked_at FROM auth_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[current.session_id,current.user_id],client)).rows[0];
    if(!session || session.revoked_at) return {status:'invalid'} as const;
    const tokenState=(await query<{revoked:boolean;rotated_at:string|null}>('SELECT revoked,rotated_at FROM refresh_tokens WHERE id=$1',[current.id],client)).rows[0]!;
    if(tokenState.rotated_at) {
      await revokeSessionInTransaction(current.user_id,current.session_id,'refresh_reuse',client);
      await recordSecurityEvent({eventType:'REFRESH_REUSE_DETECTED',userId:current.user_id,metadata:{sessionId:current.session_id}},client);
      return {status:'reused'} as const;
    }
    if(tokenState.revoked) return {status:'invalid'} as const;
    if(Math.min(new Date(session.expires_at).getTime(),new Date(current.expires_at).getTime())<=Date.now()) {
      await revokeSessionInTransaction(current.user_id,current.session_id,'expired',client);
      return {status:'expired'} as const;
    }
    const user=(await query<User>(`SELECT ${userColumns} FROM users WHERE id=$1 AND deleted_at IS NULL`,[current.user_id],client)).rows[0];
    if(!user?.verified_at) { await revokeSessionInTransaction(current.user_id,current.session_id,'account_unavailable',client); return {status:'invalid'} as const; }
    await query('UPDATE refresh_tokens SET revoked=TRUE,rotated_at=NOW(),last_used_at=NOW(),revocation_reason=$2 WHERE id=$1',[current.id,'rotated'],client);
    await query('UPDATE auth_sessions SET last_used_at=NOW() WHERE id=$1',[current.session_id],client);
    const impersonator=current.impersonated_by_user_id&&current.impersonated_by_email?{userId:current.impersonated_by_user_id,email:current.impersonated_by_email}:null;
    const refreshToken=await insertRefresh(current.user_id,current.session_id,new Date(session.expires_at),impersonator,client);
    return {status:'rotated',userId:current.user_id,sessionId:current.session_id,refreshToken,impersonator} as const;
  });
}
export async function revokeRefreshToken(rawToken:string) {
  const [selector,validator,...extra]=rawToken.split('.');
  if(!selector||!validator||extra.length) return;
  const row=(await query<{user_id:string;session_id:string;token_hash:string}>('SELECT user_id,session_id,token_hash FROM refresh_tokens WHERE selector=$1',[selector])).rows[0];
  if(row && await bcrypt.compare(validator,row.token_hash)) await revokeSession(row.user_id,row.session_id);
}
