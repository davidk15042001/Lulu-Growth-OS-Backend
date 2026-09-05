import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { query } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import { recordSecurityEvent } from '../security/security-event.service.js';

export const ADMIN_CAPABILITIES = ['users.read','users.manage','users.impersonate','workspaces.read','workspaces.manage',
  'billing.read','billing.manage','billing.bypass','security.read','security.manage','providers.read','providers.manage',
  'agents.read','agents.manage','audit.read'] as const;
export type AdminCapability = typeof ADMIN_CAPABILITIES[number];
export const ADMIN_ROLE_CAPABILITIES: Record<string, readonly AdminCapability[]> = {
  SUPER_ADMIN: ADMIN_CAPABILITIES,
  SUPPORT_ADMIN: ['users.read','workspaces.read','providers.read','agents.read'],
  FINANCE_ADMIN: ['billing.read','billing.manage'],
  SECURITY_ADMIN: ['users.read','security.read','security.manage','audit.read'],
  OPERATIONS_ADMIN: ['workspaces.read','providers.read','providers.manage','agents.read','agents.manage'],
  READ_ONLY_ADMIN: ['users.read','workspaces.read','billing.read','security.read','providers.read','agents.read','audit.read'],
};
export function capabilitiesForRoles(roles: readonly string[]): AdminCapability[] {
  return [...new Set(roles.flatMap(role=>ADMIN_ROLE_CAPABILITIES[role]??[]))];
}
export async function getAdminCapabilities(userId:string) {
  const rows=(await query<{role:string}>(`SELECT r.role FROM admin_user_roles r JOIN users u ON u.id=r.user_id
    WHERE u.id=$1 AND u.role='admin' AND u.verified_at IS NOT NULL AND u.deleted_at IS NULL`,[userId])).rows;
  return capabilitiesForRoles(rows.map(row=>row.role));
}
export async function hasAdminCapability(userId:string|null|undefined,capability:AdminCapability) {
  return Boolean(userId && (await getAdminCapabilities(userId)).includes(capability));
}
export async function assertAdminCapability(userId:string,capability:AdminCapability) {
  if(!await hasAdminCapability(userId,capability)) {
    await recordSecurityEvent({eventType:'AUTHORIZATION_DENIED',userId,metadata:{capability}});
    throw new AppError(403,'ADMIN_CAPABILITY_REQUIRED','This administrator permission is required',{capability});
  }
}
export function requireAdminCapabilities(...capabilities:AdminCapability[]) {
  return async (req:AuthedRequest,res:Response,next:NextFunction)=>{
    try {
      if(!req.user || req.impersonator) throw new AppError(403,'ADMIN_CAPABILITY_REQUIRED','Administrator access required');
      const granted=await getAdminCapabilities(req.user.id);
      for(const capability of capabilities) if(!granted.includes(capability)) await assertAdminCapability(req.user.id,capability);
      // Durable intent before the controller runs; no body, headers or secrets stored.
      const action=`${req.method} ${req.route?.path??''}`;
      await recordSecurityEvent({eventType:'ADMIN_ACTION',userId:req.user.id,requestId:String(req.id??''),metadata:{action,outcome:'authorized',targetId:req.params.userId??req.params.workspaceId??null}});
      req.adminCapabilities=granted;
      res.once('finish',()=>{ void recordSecurityEvent({eventType:'ADMIN_ACTION',userId:req.user!.id,requestId:String(req.id??''),metadata:{action,outcome:res.statusCode<400?'completed':'failed'}})
        .catch(()=>logger.error('Admin outcome audit could not be persisted')); });
      next();
    } catch(error) { next(error); }
  };
}
