import { createHash } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertAiBillingAccess } from '../billing/payg-billing.repo.js';
import { getAgentCapabilities, isAgentModule, type SubscriptionPlan } from './agent.capabilities.js';
import { evaluateAgentActionPolicy } from './agent.autonomy-policy.js';
import { roleCan } from '../workspaces/workspace-permissions.js';
import { resolveWorkspaceEntitlements } from '../entitlements/entitlement.service.js';
import type { AgentExecutionCommand } from './agent.execution-command.js';
import type { WorkspaceRecord } from '../records/record.repo.js';

export type AgentExecutionIdentity = {workspaceId:string;userId:string;runId:string;stepId:string};
function packetPolicy(command: AgentExecutionCommand, state: { capabilities: { autonomous: boolean } }, _record: WorkspaceRecord) {
  return evaluateAgentActionPolicy(command.type, state.capabilities.autonomous, {
    highRisk: command.riskLevel === 'high',
    budgetProtected: command.budgetAuthority === 'customer_authorization_required',
  });
}
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
  if(!state || !roleCan(state.role, 'agents.execute') || !['planner','analyst','strategist','executor','reviewer'].includes(state.agent_role)) return deny(context,'tenant_or_actor_permission');
  if(!isAgentModule(state.module) || !['active','trialing'].includes(state.subscription_status)) return deny(context,'inactive_entitlement');
  const effectiveEntitlements = await resolveWorkspaceEntitlements(context.workspaceId);
  if (!effectiveEntitlements['ai.enabled'].enabled) return deny(context, 'ai_entitlement_disabled');
  // Plan-specific agent behavior is retained for compatibility, but it may
  // never exceed the backend-owned effective entitlement set. In particular,
  // autonomous/write actions require an explicit autonomous-agent entitlement.
  const planCapabilities=getAgentCapabilities(state.plan_key,state.module);
  const autonomousEnabled = effectiveEntitlements['ai.autonomous_agents'].enabled;
  const capabilities = {
    ...planCapabilities,
    act: planCapabilities.act && autonomousEnabled,
    autonomous: planCapabilities.autonomous && autonomousEnabled,
    automatic: planCapabilities.automatic && autonomousEnabled,
  };
  if(!capabilities.analyze || (write && !capabilities.act)) return deny(context,'missing_entitlement');
  await assertAiBillingAccess(context.workspaceId,context.userId);
  return {...state,capabilities};
}

export async function authorizeAgentTool(context:AgentExecutionIdentity,toolName:string|null) {
  const state=await authorizeAgentIdentity(context,toolName==='page_action_writeback');
  if(state.tool_name!==toolName) return deny(context,'tool_identity_mismatch');
  const policy=evaluateAgentActionPolicy(`tool:${toolName??'agent.reason'}`,state.capabilities.autonomous);
  if(policy.decision==='forbidden') return deny(context,'prohibited_tool');
  if(policy.decision==='require_budget') return deny(context,'customer_budget_must_be_funded');
  return policy;
}

export async function registerAgentActionPacket(context:AgentExecutionIdentity,record:WorkspaceRecord,commands:AgentExecutionCommand[]) {
  const state=await authorizeAgentIdentity(context,true);
  if(state.tool_name!=='page_action_writeback' || record.workspaceId!==context.workspaceId || record.createdBy!==context.userId) return deny(context,'packet_identity_mismatch');
  const policies=commands.map(command=>packetPolicy(command,state,record));
  if(!commands.length || policies.some(policy=>policy.decision==='forbidden')) return deny(context,'prohibited_command');
  const digest=packetDigest(record);
  if(policies.some(policy=>policy.decision==='require_budget')) return deny(context,'customer_budget_must_be_funded');
  await withTransaction(async client=>{
    await query(`INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [record.id,context.workspaceId,context.runId,context.stepId,context.userId,digest,null],client);
    const patch={executionReady:true,executionStatus:'queued',approvalId:null,approvalStatus:'not_required'};
    await query(`UPDATE workspace_records SET stage='queued_for_execution',data=data||$3::jsonb,version=version+1 WHERE workspace_id=$1 AND id=$2`,[context.workspaceId,record.id,JSON.stringify(patch)],client);
    Object.assign(record,{stage:'queued_for_execution',version:record.version+1,data:{...record.data,...patch}});
  });
  return {executionReady:true,approvalId:null};
}

/** The only entry into the existing command dispatcher, for manual AND event work. */
export async function executeAuthorizedAgentPacket<T>(record:WorkspaceRecord,commands:AgentExecutionCommand[],dispatch:(command:AgentExecutionCommand)=>Promise<T>) {
  const packet=(await query<{run_id:string;step_id:string;user_id:string;commands_digest:string;approval_id:string|null}>(`SELECT * FROM agent_action_packets WHERE record_id=$1 AND workspace_id=$2`,[record.id,record.workspaceId])).rows[0];
  if(!packet) return deny({workspaceId:record.workspaceId},'untrusted_action_packet');
  const context={workspaceId:record.workspaceId,userId:packet.user_id,runId:packet.run_id,stepId:packet.step_id};
  const state=await authorizeAgentIdentity(context,true);
  if(record.createdBy!==packet.user_id || packet.commands_digest!==packetDigest(record) || agentActionDigest(commands)!==agentActionDigest(record.data?.commands)) return deny(context,'action_packet_tampered');
  const policies=commands.map(command=>packetPolicy(command,state,record));
  if(!commands.length || policies.some(policy=>policy.decision==='forbidden')) return deny(context,'prohibited_command');
  if(policies.some(policy=>policy.decision==='require_budget')) {
    return deny(context,'customer_budget_must_be_funded');
  }
  const results:T[]=[];
  for(const command of commands) {
    await authorizeAgentIdentity(context,true);
    results.push(await dispatch(command));
  }
  return results;
}
