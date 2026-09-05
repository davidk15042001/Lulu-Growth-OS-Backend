import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';

export type SecurityEventType = 'LOGIN_SUCCESS' | 'LOGIN_FAILURE' | 'EMAIL_VERIFIED'
  | 'EMAIL_VERIFICATION_FAILED' | 'EMAIL_VERIFICATION_ISSUED' | 'EMAIL_VERIFICATION_SENT' | 'EMAIL_DELIVERY_FAILED'
  | 'SESSION_CREATED' | 'SESSION_REVOKED' | 'REFRESH_REUSE_DETECTED' | 'ADMIN_ACTION'
  | 'AUTHORIZATION_DENIED' | 'HIGH_RISK_ACTION_BLOCKED' | 'PROVIDER_CREDENTIAL_CHANGED'
  | 'DOMAIN_VERIFIED' | 'DOMAIN_VERIFICATION_FAILED' | 'DOMAIN_VERIFICATION_ISSUED';
const metadataKeys = new Set(['sessionId','action','reason','outcome','targetId','capability','role','agentId','runId','stepId','recordId','domainId','siteId','provider','keyVersion','approvalId']);
export function safeSecurityMetadata(value: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => metadataKeys.has(key)
    && (typeof item === 'boolean' || typeof item === 'number' || (typeof item === 'string' && item.length <= 200))));
}
export async function recordSecurityEvent(input: {
  eventType: SecurityEventType; userId?: string | null; workspaceId?: string | null;
  requestId?: string | null; correlationId?: string | null; metadata?: Record<string, unknown>;
}, client?: PoolClient) {
  await query(`INSERT INTO security_events(workspace_id,user_id,event_type,request_id,correlation_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6)`, [input.workspaceId ?? null,input.userId ?? null,input.eventType,
    input.requestId?.slice(0,100) ?? null,input.correlationId?.slice(0,100) ?? null,safeSecurityMetadata(input.metadata)], client);
}
