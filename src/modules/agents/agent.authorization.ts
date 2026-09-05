import { createHash } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertAiBillingAccess } from '../billing/payg-billing.repo.js';
import { createApproval } from '../approvals/approval.repo.js';
import { getAgentCapabilities, isAgentModule, type SubscriptionPlan } from './agent.capabilities.js';
import { evaluateAgentActionPolicy } from './agent.autonomy-policy.js';
import type { AgentExecutionCommand } from './agent.execution-command.js';
import type { WorkspaceRecord } from '../records/record.repo.js';

export type AgentExecutionIdentity = {workspaceId:string;userId:string;runId:string;stepId:string};
function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const agentActionDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const packetDigest=(record:WorkspaceRecord)=>agentActionDigest({resourceType:record.resourceType,commands:record.data?.commands,module:record.data?.module,budgetProtected:record.data?.budgetProtected});

async function deny(context:Partial<AgentExecutionIdentity>,reason:string):Promise<never> {
  const uuid=(value:string|undefined)=>value && /^[a-f\d-]{36}$/i.test(value)?value:null;
  await recordSecurityEvent({eventType:'HIGH_RISK_ACTION_BLOCKED',workspaceId:uuid(context.workspaceId),userId:uuid(context.userId),metadata:{reason,runId:context.runId,stepId:context.stepId}});
  throw new AppError(403,'AGENT_EXECUTION_FORBIDDEN',`Agent execution forbidden: ${reason}`);
}

export async function authorizeAgentIdentity(context:AgentExecutionIdentity,write=false) {
  if(![context.workspaceId,context.userId,context.runId,context.stepId].every(value=>/^[a-f\d-]{36}$/i.test(value))) return deny(context,'invalid_identity');
  const state=(await query<{module:unknown;tool_name:string|null;agent_role:string;tool_input:unknown;approval_id:string|null;plan_key:SubscriptionPlan;subscription_status:string;role:string}>(
    `SELECT r.plan->>'module' AS module,s.tool_name,s.agent_role,s.tool_input,s.approval_id,p.plan_key,p.status AS subscription_status,m.role
      FROM agent_runs r JOIN agent_run_steps s ON s.run_id=r.id AND s.workspace_id=r.workspace_id
      JOIN workspaces w ON w.id=r.workspace_id AND w.deleted_at IS NULL
      JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$2
      JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL AND u.verified_at IS NOT NULL
      JOIN workspace_subscriptions p ON p.workspace_id=w.id
      WHERE r.workspace_id=$1 AND r.id=$3 AND s.id=$4 AND COALESCE(r.created_by,w.created_by)=$2
        AND r.status NOT IN ('failed','cancelled')`,[context.workspaceId,context.userId,context.runId,context.stepId])).rows[0];
  if(!state || !['owner','admin','member'].includes(state.role) || !['planner','analyst','strategist','executor','reviewer'].includes(state.agent_role)) return deny(context,'tenant_or_actor_permission');
  if(!isAgentModule(state.module) || !['active','trialing'].includes(state.subscription_status)) return deny(context,'inactive_entitlement');
  const capabilities=getAgentCapabilities(state.plan_key,state.module);
  if(!capabilities.analyze || (write && !capabilities.act)) return deny(context,'missing_entitlement');
  await assertAiBillingAccess(context.workspaceId,context.userId);
  return {...state,capabilities};
}

async function consumeApproval(context:AgentExecutionIdentity,approvalId:string,action:string,entityId:string,digest:string) {
  // One approval authorizes one exact operation. Never trust JSON approvedBy/approvedAt.
  const consumed=await withTransaction(async client=>{
    const row=(await query<{id:string}>(`UPDATE approval_requests a SET authorization_consumed_at=NOW()
      WHERE a.id=$1 AND a.workspace_id=$2 AND a.action_type=$3 AND a.entity_id=$4 AND a.payload->>'digest'=$5
      AND a.status='approved' AND a.authorization_consumed_at IS NULL AND a.expires_at>NOW()
      AND EXISTS(SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=a.workspace_id AND m.user_id=a.decided_by AND m.role IN ('owner','admin') AND u.verified_at IS NOT NULL AND u.deleted_at IS NULL)
      RETURNING a.id`,[approvalId,context.workspaceId,action,entityId,digest],client)).rows[0];
    if(row) await recordSecurityEvent({eventType:'ADMIN_ACTION',workspaceId:context.workspaceId,userId:context.userId,metadata:{action:'agent_authorization_consumed',approvalId,stepId:context.stepId}},client);
    return Boolean(row);
  });
  if(!consumed) return deny(context,'approval_missing_expired_consumed_or_untrusted');
}

export async function authorizeAgentTool(context:AgentExecutionIdentity,toolName:string|null) {
  const state=await authorizeAgentIdentity(context,toolName==='page_action_writeback');
  if(state.tool_name!==toolName) return deny(context,'tool_identity_mismatch');
  const policy=evaluateAgentActionPolicy(`tool:${toolName??'agent.reason'}`,state.capabilities.autonomous);
  if(policy.decision==='forbidden') return deny(context,'prohibited_tool');
  if(policy.decision==='require_approval' && state.approval_id) {
    await consumeApproval(context,state.approval_id,`agent_tool:${toolName}`,context.stepId,agentActionDigest(state.tool_input??{}));
    return {...policy,decision:'allow' as const};
  }
  return policy;
}

export async function registerAgentActionPacket(context:AgentExecutionIdentity,record:WorkspaceRecord,commands:AgentExecutionCommand[]) {
  const state=await authorizeAgentIdentity(context,true);
  if(state.tool_name!=='page_action_writeback' || record.workspaceId!==context.workspaceId || record.createdBy!==context.userId) return deny(context,'packet_identity_mismatch');
  const policies=commands.map(command=>evaluateAgentActionPolicy(command.type,state.capabilities.autonomous,{highRisk:command.riskLevel==='high',budgetProtected:record.data?.budgetProtected===true}));
  if(!commands.length || policies.some(policy=>policy.decision==='forbidden')) return deny(context,'prohibited_command');
  const digest=packetDigest(record);
  const requiresApproval=policies.some(policy=>policy.decision==='require_approval');
  const approval=requiresApproval?await createApproval(context.workspaceId,context.userId,{
    actionType:'agent_packet',entityType:'workspace_record',entityId:record.id,title:`Authorize ${record.name}`.slice(0,200),
    description:commands.map(command=>`${command.type}: ${command.summary}`).join('\n').slice(0,2000),
    payload:{digest,recordId:record.id,runId:context.runId,stepId:context.stepId,commands},
    expiresAt:new Date(Date.now()+86_400_000).toISOString(),
  }):null;
  await withTransaction(async client=>{
    await query(`INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [record.id,context.workspaceId,context.runId,context.stepId,context.userId,digest,approval?.id??null],client);
    const patch={executionReady:!requiresApproval,executionStatus:requiresApproval?'waiting_approval':'queued',approvalId:approval?.id??null,approvalStatus:requiresApproval?'pending':'not_required'};
    await query(`UPDATE workspace_records SET stage=$3,data=data||$4::jsonb,version=version+1 WHERE workspace_id=$1 AND id=$2`,[context.workspaceId,record.id,requiresApproval?'waiting_approval':'queued_for_execution',JSON.stringify(patch)],client);
    Object.assign(record,{stage:requiresApproval?'waiting_approval':'queued_for_execution',version:record.version+1,data:{...record.data,...patch}});
  });
  return {executionReady:!requiresApproval,approvalId:approval?.id??null};
}

/** The only entry into the existing command dispatcher, for manual AND event work. */
export async function executeAuthorizedAgentPacket<T>(record:WorkspaceRecord,commands:AgentExecutionCommand[],dispatch:(command:AgentExecutionCommand)=>Promise<T>) {
  const packet=(await query<{run_id:string;step_id:string;user_id:string;commands_digest:string;approval_id:string|null}>(`SELECT * FROM agent_action_packets WHERE record_id=$1 AND workspace_id=$2`,[record.id,record.workspaceId])).rows[0];
  if(!packet) return deny({workspaceId:record.workspaceId},'untrusted_action_packet');
  const context={workspaceId:record.workspaceId,userId:packet.user_id,runId:packet.run_id,stepId:packet.step_id};
  const state=await authorizeAgentIdentity(context,true);
  if(record.createdBy!==packet.user_id || packet.commands_digest!==packetDigest(record) || agentActionDigest(commands)!==agentActionDigest(record.data?.commands)) return deny(context,'action_packet_tampered');
  const policies=commands.map(command=>evaluateAgentActionPolicy(command.type,state.capabilities.autonomous,{highRisk:command.riskLevel==='high',budgetProtected:record.data?.budgetProtected===true}));
  if(!commands.length || policies.some(policy=>policy.decision==='forbidden')) return deny(context,'prohibited_command');
  if(policies.some(policy=>policy.decision==='require_approval')) {
    if(!packet.approval_id) return deny(context,'approval_required');
    await consumeApproval(context,packet.approval_id,'agent_packet',record.id,packet.commands_digest);
  }
  const results:T[]=[];
  for(const command of commands) {
    await authorizeAgentIdentity(context,true);
    results.push(await dispatch(command));
  }
  return results;
}

export async function releaseApprovedAgentPackets(workspaceId?:string,approvalId?:string) {
  // Read approval state, not event payload assertions. Also recovers missed wakeups.
  await query(`UPDATE workspace_records r SET stage='queued_for_execution',data=r.data||'{"executionReady":true,"executionStatus":"queued"}'::jsonb,version=r.version+1
    FROM agent_action_packets p JOIN approval_requests a ON a.id=p.approval_id AND a.workspace_id=p.workspace_id
    WHERE r.id=p.record_id AND r.workspace_id=p.workspace_id AND r.stage='waiting_approval' AND r.deleted_at IS NULL
      AND a.status='approved' AND a.authorization_consumed_at IS NULL AND a.expires_at>NOW()
      AND ($1::uuid IS NULL OR p.workspace_id=$1) AND ($2::uuid IS NULL OR a.id=$2)`,[workspaceId??null,approvalId??null]);
}
