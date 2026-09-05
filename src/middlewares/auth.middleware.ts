import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/pool.js';
import { forbidden, jsonError, unauthorized } from '../utils/response.js';
import { extractBearerToken, verifyToken, type JwtPayload } from '../utils/jwt.js';
import { hasAdminCapability, type AdminCapability } from '../modules/admin/admin.authorization.js';
import { recordSecurityEvent } from '../modules/security/security-event.service.js';

export type AuthedRequest = Request & {
  user?: { id: string; email: string; role: 'user' | 'admin' };
  sessionId?: string;
  adminCapabilities?: AdminCapability[];
  impersonator?: { id: string; email: string };
};
export async function requireAuth(req:AuthedRequest,res:Response,next:NextFunction) {
  const token=extractBearerToken(req.headers.authorization);
  if(!token) return unauthorized(res,'Authentication required');
  let payload:JwtPayload;
  try { payload=verifyToken<JwtPayload>(token); }
  catch { return unauthorized(res,'Invalid or expired token'); }
  // Old signed tokens can be exchanged via the migrated refresh cookie.
  if(!payload.sid) return jsonError(res,401,'SESSION_REFRESH_REQUIRED','Please refresh your session');
  try {
    const row=(await query<{email:string;token_version:number;role:'user'|'admin';deleted_at:string|null;verified_at:string|null;session_active:boolean;impersonated_by_user_id:string|null}>(
      `SELECT u.email,u.token_version,u.role,u.deleted_at,u.verified_at,
        (s.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>NOW()) AS session_active,s.impersonated_by_user_id
       FROM users u LEFT JOIN auth_sessions s ON s.user_id=u.id AND s.id=$2 WHERE u.id=$1`,[payload.sub,payload.sid])).rows[0];
    if(!row) return unauthorized(res,'Invalid session');
    if(row.deleted_at) return forbidden(res,'Account disabled');
    if(!row.verified_at) return jsonError(res,403,'ACCOUNT_UNVERIFIED','Verify your email to continue');
    if(!row.session_active || (payload.tv??0)!==row.token_version) return jsonError(res,401,'TOKEN_REVOKED','This session has ended. Please sign in again');
    if((row.impersonated_by_user_id??null)!==(payload.impersonatorUserId??null)) return unauthorized(res,'Invalid session');
    if(payload.impersonatorUserId) {
      if(!await hasAdminCapability(payload.impersonatorUserId,'users.impersonate')) {
        await recordSecurityEvent({eventType:'AUTHORIZATION_DENIED',userId:payload.impersonatorUserId,metadata:{reason:'impersonation_revoked'}});
        return forbidden(res,'Impersonation permission has ended');
      }
      req.impersonator={id:payload.impersonatorUserId,email:payload.impersonatorEmail??''};
    }
    req.sessionId=payload.sid;
    req.user={id:payload.sub,email:row.email,role:row.role};
    next();
  } catch(error) { next(error); }
}
