import { createHash } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertAiBillingAccess } from '../billing/payg-billing.repo.js';
import { assertApiWalletFunded, isApiWalletMeteredWorkspace } from '../api-wallet/api-wallet.repo.js';
import { getAgentCapabilities, isAgentModule, type SubscriptionPlan } from './agent.capabilities.js';
import { evaluateAgentActionPolicy } from './agent.autonomy-policy.js';
import { isWorkspaceCapability, type WorkspaceCapability } from '../workspaces/workspace-permissions.js';
import { authorizeWorkspaceAction } from '../workspaces/workspace-authorization.service.js';
import { resolveWorkspaceEntitlements } from '../entitlements/entitlement.service.js';
import type { AgentExecutionCommand } from './agent.execution-command.js';
import type { WorkspaceRecord } from '../records/record.repo.js';
import { assertAdBudgetAuthorization } from '../adspend/adspend.repo.js';
import { requiredCapabilitiesForAgentCommands } from './agent.command-capabilities.js';
import { providerRequirementForAgentCommand } from './agent.provider-requirements.js';
import { assertWorkspaceProviderLaunchReady } from '../provider-control/provider.service.js';
import { isWorkspaceAutomationPaused } from '../workspaces/workspace-automation.service.js';

export type AgentExecutionIdentity = {workspaceId:string;userId:string;runId:string;stepId:string};
type AgentIdentityState = {
  module: unknown;
  tool_name: string | null;
  agent_role: string;
  tool_input: unknown;
  approval_id: string | null;
  plan_key: SubscriptionPlan;
  subscription_status: string;
  role: string | null;
  execution_actor_type: 'USER' | 'WORKFLOW';
  execution_actor_ref: string | null;
  execution_capability_scope: unknown;
};

function capabilityScope(value: unknown): WorkspaceCapability[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is WorkspaceCapability => typeof entry === 'string' && isWorkspaceCapability(entry)))].sort()
    : [];
}
function packetPolicy(command: AgentExecutionCommand, state: { capabilities: { autonomous: boolean } }, budgetVerified: boolean) {
  return evaluateAgentActionPolicy(command.type, state.capabilities.autonomous, {
    highRisk: command.riskLevel === 'high',
    budgetProtected: command.budgetAuthority === 'customer_authorization_required' && !budgetVerified,
  });
}

function packetText(value: unknown, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function verifyCommandBudget(workspaceId: string, command: AgentExecutionCommand) {
  if (command.budgetAuthority !== 'customer_authorization_required') return false;
  const payload = command.payload;
  const authorizationId = packetText(payload.authorizationId, 120);
  const provider = packetText(command.provider ?? payload.provider, 80);
  const accountId = packetText(payload.accountId ?? payload.customerId);
  const campaignId = packetText(payload.campaignId ?? command.targetEntityId);
  const currency = packetText(payload.currency ?? payload.accountCurrency, 3).toUpperCase();
  const amount = typeof payload.budgetAmountCny === 'number' ? payload.budgetAmountCny : Number(payload.budgetAmountCny);
  if (!authorizationId || !provider || !accountId || !campaignId || !currency || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'Paid advertising requires an explicit customer campaign budget authorization.');
  }
  await assertAdBudgetAuthorization({ workspaceId, authorizationId, provider, accountId, campaignId, currency, amount });
  return true;
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
  const state=(await query<AgentIdentityState>(
    `SELECT r.plan->>'module' AS module,s.tool_name,s.agent_role,s.tool_input,s.approval_id,
            CASE WHEN w.billing_skipped_at IS NOT NULL THEN 'ai' ELSE p.plan_key END AS plan_key,
            CASE WHEN w.billing_skipped_at IS NOT NULL THEN 'billing_skipped' ELSE p.status END AS subscription_status,
            m.role,r.execution_actor_type,r.execution_actor_ref,r.execution_capability_scope
      FROM agent_runs r JOIN agent_run_steps s ON s.run_id=r.id AND s.workspace_id=r.workspace_id
      JOIN workspaces w ON w.id=r.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$2
      LEFT JOIN users u ON u.id=$2 AND u.deleted_at IS NULL AND u.verified_at IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT subscription.plan_key,subscription.status
        FROM workspace_subscriptions subscription
        WHERE subscription.workspace_id=w.id
        ORDER BY subscription.updated_at DESC
        LIMIT 1
      ) p ON TRUE
      WHERE r.workspace_id=$1 AND r.id=$3 AND s.id=$4
        AND (
          (r.execution_actor_type='USER' AND r.created_by=$2 AND m.user_id IS NOT NULL AND u.id IS NOT NULL)
          OR (
            r.execution_actor_type='WORKFLOW'
            AND COALESCE(r.created_by,w.created_by)=$2
            AND NULLIF(r.execution_actor_ref,'') IS NOT NULL
          )
        )
        AND (w.billing_skipped_at IS NOT NULL OR p.plan_key IS NOT NULL)
        AND r.status NOT IN ('failed','cancelled')`,[context.workspaceId,context.userId,context.runId,context.stepId])).rows[0];
  if(!state || !['planner','analyst','strategist','executor','reviewer'].includes(state.agent_role)) return deny(context,'tenant_or_actor_permission');
  const serviceScope = capabilityScope(state.execution_capability_scope);
  if (state.execution_actor_type === 'USER') {
    const decision = await authorizeWorkspaceAction({
      workspaceId: context.workspaceId,
      userId: context.userId,
      capability: 'agents.execute',
      actorType: 'AI_AGENT',
      context: { runId: context.runId, stepId: context.stepId },
    });
    if (!decision.allowed) return deny(context, 'tenant_or_actor_permission');
  } else if (!serviceScope.includes('agents.execute')) {
    return deny(context, 'scoped_service_identity_missing_agents_execute');
  }
  if(!isAgentModule(state.module) || !['active','trialing','billing_skipped'].includes(state.subscription_status)) return deny(context,'inactive_entitlement');
  const effectiveEntitlements = await resolveWorkspaceEntitlements(context.workspaceId);
  if (!effectiveEntitlements['ai.enabled'].enabled) return deny(context, 'ai_entitlement_disabled');
  if (await isWorkspaceAutomationPaused(context.workspaceId)) return deny(context, 'workspace_automation_paused');
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
  if (state.execution_actor_type === 'WORKFLOW' && await isApiWalletMeteredWorkspace(context.workspaceId)) {
    // Admin status and billing-skip entitlement never mint or substitute for
    // prepaid AI funds. Automatic service principals always honor the wallet.
    await assertApiWalletFunded(context.workspaceId);
  } else {
    await assertAiBillingAccess(context.workspaceId,context.userId);
  }
  return {...state,serviceScope,capabilities};
}

export async function authorizeAgentTool(context:AgentExecutionIdentity,toolName:string|null) {
  const state=await authorizeAgentIdentity(context,toolName==='page_action_writeback');
  if(state.tool_name!==toolName) return deny(context,'tool_identity_mismatch');
  const policy=evaluateAgentActionPolicy(`tool:${toolName??'agent.reason'}`,state.capabilities.autonomous);
  if(policy.decision==='forbidden') return deny(context,'prohibited_tool');
  if(policy.decision==='require_budget') return deny(context,'customer_budget_must_be_funded');
  return policy;
}

async function assertCommandCapabilities(
  context: AgentExecutionIdentity,
  state: Awaited<ReturnType<typeof authorizeAgentIdentity>>,
  commands: readonly AgentExecutionCommand[],
) {
  let required: WorkspaceCapability[];
  try {
    required = requiredCapabilitiesForAgentCommands(commands.map((command) => command.type));
  } catch {
    return deny(context, 'command_capability_mapping_missing');
  }
  if (state.execution_actor_type === 'WORKFLOW') {
    const missing = required.find((capability) => !state.serviceScope.includes(capability));
    if (missing) return deny(context, `scoped_service_capability_required:${missing}`);
    return required;
  }
  for (const capability of required) {
    const decision = await authorizeWorkspaceAction({
      workspaceId: context.workspaceId,
      userId: context.userId,
      capability,
      actorType: 'AI_AGENT',
      context: { runId: context.runId, stepId: context.stepId, commandTypes: commands.map((command) => command.type) },
    });
    if (!decision.allowed) return deny(context, `command_capability_required:${capability}`);
  }
  return required;
}

async function assertCommandProviderReadiness(workspaceId: string, commands: readonly AgentExecutionCommand[]) {
  for (const command of commands) {
    const requirement = providerRequirementForAgentCommand(command);
    if (!requirement.required) continue;
    await assertWorkspaceProviderLaunchReady(workspaceId, requirement.providerKey, requirement.reason);
  }
}

export async function registerAgentActionPacket(context:AgentExecutionIdentity,record:WorkspaceRecord,commands:AgentExecutionCommand[]) {
  const state=await authorizeAgentIdentity(context,true);
  if(state.tool_name!=='page_action_writeback' || record.workspaceId!==context.workspaceId || record.createdBy!==context.userId) return deny(context,'packet_identity_mismatch');
  const verifiedBudgets=await Promise.all(commands.map(command=>verifyCommandBudget(context.workspaceId,command)));
  const policies=commands.map((command,index)=>packetPolicy(command,state,verifiedBudgets[index]??false));
  if(!commands.length || policies.some(policy=>policy.decision==='forbidden')) return deny(context,'prohibited_command');
  const requiredCapabilities = await assertCommandCapabilities(context, state, commands);
  await assertCommandProviderReadiness(context.workspaceId, commands);
  const digest=packetDigest(record);
  if(policies.some(policy=>policy.decision==='require_budget')) return deny(context,'customer_budget_must_be_funded');
  await withTransaction(async client=>{
    await query(`INSERT INTO agent_action_packets(
        record_id,workspace_id,run_id,step_id,user_id,commands_digest,approval_id,
        actor_type,actor_ref,required_capabilities
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [record.id,context.workspaceId,context.runId,context.stepId,context.userId,digest,null,
        state.execution_actor_type,state.execution_actor_ref,JSON.stringify(requiredCapabilities)],client);
    const patch={executionReady:true,executionStatus:'queued',approvalId:null,approvalStatus:'not_required'};
    await query(`UPDATE workspace_records SET stage='queued_for_execution',data=data||$3::jsonb,version=version+1 WHERE workspace_id=$1 AND id=$2`,[context.workspaceId,record.id,JSON.stringify(patch)],client);
    Object.assign(record,{stage:'queued_for_execution',version:record.version+1,data:{...record.data,...patch}});
  });
  return {executionReady:true,approvalId:null};
}

/** The only entry into the existing command dispatcher, for manual AND event work. */
export async function executeAuthorizedAgentPacket<T>(record:WorkspaceRecord,commands:AgentExecutionCommand[],dispatch:(command:AgentExecutionCommand)=>Promise<T>) {
  const packet=(await query<{
    run_id:string;step_id:string;user_id:string;commands_digest:string;approval_id:string|null;
    actor_type:'USER'|'WORKFLOW';actor_ref:string|null;required_capabilities:unknown;
  }>(`SELECT * FROM agent_action_packets WHERE record_id=$1 AND workspace_id=$2`,[record.id,record.workspaceId])).rows[0];
  if(!packet) return deny({workspaceId:record.workspaceId},'untrusted_action_packet');
  const context={workspaceId:record.workspaceId,userId:packet.user_id,runId:packet.run_id,stepId:packet.step_id};
  const state=await authorizeAgentIdentity(context,true);
  let requiredCapabilities: WorkspaceCapability[];
  try {
    requiredCapabilities = requiredCapabilitiesForAgentCommands(commands.map((command) => command.type));
  } catch {
    return deny(context, 'command_capability_mapping_missing');
  }
  const storedRequiredCapabilities = capabilityScope(packet.required_capabilities);
  if(record.createdBy!==packet.user_id
    || packet.commands_digest!==packetDigest(record)
    || agentActionDigest(commands)!==agentActionDigest(record.data?.commands)
    || packet.actor_type!==state.execution_actor_type
    || packet.actor_ref!==state.execution_actor_ref
    || agentActionDigest(storedRequiredCapabilities)!==agentActionDigest(requiredCapabilities)) return deny(context,'action_packet_tampered');
  if(!commands.length) return deny(context,'prohibited_command');
  await assertCommandCapabilities(context, state, commands);
  const verifiedBudgets=await Promise.all(commands.map(command=>verifyCommandBudget(record.workspaceId,command)));
  await assertCommandProviderReadiness(record.workspaceId, commands);
  const policies=commands.map((command,index)=>packetPolicy(command,state,verifiedBudgets[index]??false));
  if(policies.some(policy=>policy.decision==='forbidden')) return deny(context,'prohibited_command');
  if(policies.some(policy=>policy.decision==='require_budget')) {
    return deny(context,'customer_budget_must_be_funded');
  }
  const results:T[]=[];
  for(const command of commands) {
    const currentState = await authorizeAgentIdentity(context,true);
    await assertCommandCapabilities(context, currentState, [command]);
    results.push(await dispatch(command));
  }
  return results;
}
