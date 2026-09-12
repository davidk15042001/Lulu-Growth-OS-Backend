import assert from 'node:assert/strict';
import { before, after, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgres://test:test@127.0.0.1:1/admin_ops';
process.env.JWT_SECRET='admin-operations-tests-secret-0123456789';
const {pool}=await import('../src/db/pool.js');
const repo=await import('../src/modules/admin/admin.repo.js');
const adminOAuthRepo=await import('../src/modules/admin/admin-oauth.repo.js');
const contentRepo=await import('../src/modules/content-generation/content-generation.repo.js');
const omniRepo=await import('../src/modules/omnichannel/omnichannel.repo.js');
const whatsappWorkspace=await import('../src/modules/provider-control/twilio-workspace.service.js');
const support=await import('../src/modules/support/support.repo.js');
const {capabilitiesForRoles}=await import('../src/modules/admin/admin.authorization.js');
const db=new PGlite();
let userId:string, workspaceId:string;
before(async()=>{
  for(const file of (await readdir('src/database/migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await readFile(`src/database/migrations/${file}`,'utf8'));
  const execute=async(sql:string,values:unknown[]=[])=>{const result=await db.query(sql,values);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length};};
  mock.method(pool,'query',execute as never);
  mock.method(pool,'connect',(async()=>({query:execute,release(){}})) as never);
  userId=(await db.query<{id:string}>(`INSERT INTO users(email,password_hash) VALUES('ops@test.local','hash') RETURNING id`)).rows[0]!.id;
  workspaceId=(await db.query<{id:string}>(`INSERT INTO workspaces(name,created_by) VALUES('Operations',$1) RETURNING id`,[userId])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[workspaceId,userId]);
});
after(async()=>{mock.restoreAll();await pool.end();await db.close();});
it('executes every admin operational query against the actual migrated schema',async()=>{
  for(const load of [repo.listWebsites,repo.listAgents,repo.listIntegrations,repo.listApprovals,repo.listErrorEvents,repo.listAuditLogs,repo.listConversations,repo.listFiles,repo.listJobs]) assert.ok(Array.isArray(await load()));
});
it('shows API and server customer costs for verified or unpaid workspaces',async()=>{
  const now=new Date();
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString().slice(0,10);
  const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).toISOString().slice(0,10);
  await db.query(`INSERT INTO ai_usage_ledger(workspace_id,user_id,provider,model,input_tokens,output_tokens,customer_cost_usd)
    VALUES($1,$2,'deepseek','deepseek-v4-pro',1,1,12.34)`,[workspaceId,userId]);
  await db.query(`INSERT INTO workspace_server_usage_ledger(workspace_id,usage_date,provider_cost_usd,customer_cost_usd)
    VALUES($1,CURRENT_DATE,2.835,5.67)`,[workspaceId]);
  const customer=(await repo.listCustomerBillingOverview(start,end)).find((row:any)=>row.id===workspaceId);
  assert.ok(customer);
  assert.equal(Number(customer.apiCostUsd),12.34);
  assert.equal(Number(customer.serverCostUsd),5.67);
  assert.equal(Number(customer.apiCostMinor),0);
});
it('lets an admin set exact API/AI and storage costs, including an audited surcharge',async()=>{
  await db.query(
    `INSERT INTO workspace_payg_profiles(workspace_id,interval_days,current_period_start,current_period_end)
     VALUES($1,7,NOW()-INTERVAL '1 hour',NOW()+INTERVAL '7 days')
     ON CONFLICT(workspace_id) DO UPDATE SET enabled=TRUE,current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end`,
    [workspaceId],
  );
  await repo.setWorkspaceUsageCosts(workspaceId,4.25,8.5,'Admin correction',userId);
  const usage=await repo.getWorkspacePaygUsage(workspaceId);
  assert.equal(usage?.apiBillableUsd,4.25);
  assert.equal(usage?.serverBillableUsd,8.5);
  const adjustments=await repo.listWorkspaceUsageAdjustments(workspaceId);
  assert.ok(adjustments.some((entry:any)=>entry.metric==='storage'&&Number(entry.amountUsd)<0));
  const audit=await db.query(`SELECT action FROM audit_log WHERE workspace_id=$1 AND action='payg_usage.costs_set'`,[workspaceId]);
  assert.equal(audit.rows.length,1);
});
it('keeps a cancelled workspace refresh cancelled when a worker reports late progress',async()=>{
  const job=await contentRepo.createJob(workspaceId,userId,['seo']);
  assert.ok(job?.id);
  const cancelled=await contentRepo.cancelJob(workspaceId,String(job.id));
  assert.equal(cancelled?.status,'cancelled');
  assert.equal(await contentRepo.updateJob(workspaceId,String(job.id),{status:'completed',progress:100}),null);
  assert.equal((await contentRepo.getJob(workspaceId,String(job.id)))?.status,'cancelled');
});
it('grants workspace-owned OAuth per provider and wipes its token when revoked',async()=>{
  assert.equal(await adminOAuthRepo.isWorkspaceOAuthSelfServiceAllowed(workspaceId,'whatsapp'),false);
  await adminOAuthRepo.setWorkspaceOAuthSelfServicePermission({workspaceId,provider:'whatsapp',allowed:true,actorId:userId});
  assert.equal(await adminOAuthRepo.isWorkspaceOAuthSelfServiceAllowed(workspaceId,'whatsapp'),true);
  const platform=(await db.query<{id:string}>(`INSERT INTO workspace_platforms(workspace_id,integration_key,name,category,connection_status)
    VALUES($1,'whatsapp','WhatsApp','messaging','connected') RETURNING id`,[workspaceId])).rows[0]!;
  await db.query(`INSERT INTO workspace_platform_oauth_credentials(platform_id,provider,encrypted_access_token)
    VALUES($1,'whatsapp','encrypted-token')`,[platform.id]);
  await adminOAuthRepo.setWorkspaceOAuthSelfServicePermission({workspaceId,provider:'whatsapp',allowed:false,actorId:userId});
  assert.equal(await adminOAuthRepo.isWorkspaceOAuthSelfServiceAllowed(workspaceId,'whatsapp'),false);
  assert.equal((await db.query(`SELECT 1 FROM workspace_platform_oauth_credentials WHERE platform_id=$1`,[platform.id])).rows.length,0);
  assert.equal((await db.query<{connection_status:string}>(`SELECT connection_status FROM workspace_platforms WHERE id=$1`,[platform.id])).rows[0]?.connection_status,'disconnected');
  await db.query(`INSERT INTO twilio_workspace_accounts(
    workspace_id,twilio_account_sid,encrypted_auth_token,waba_id,phone_number_id,sender_address,display_name,sender_status,status
  ) VALUES($1,'AC00000000000000000000000000000001','encrypted-token','12345','67890','whatsapp:+491701234567','Customer WhatsApp','CREATING','DISABLED')`,[workspaceId]);
  await db.query(`INSERT INTO provider_connections(
    scope_type,workspace_id,provider_key,mode,status,authorization_state,health_status
  ) VALUES('WORKSPACE',$1,'whatsapp','CUSTOMER_OWNED','DISCONNECTED','NOT_AUTHORIZED','DISCONNECTED')`,[workspaceId]);
  await adminOAuthRepo.setWorkspaceOAuthSelfServicePermission({workspaceId,provider:'whatsapp',allowed:true,actorId:userId});
  assert.equal((await db.query<{status:string}>(`SELECT status FROM twilio_workspace_accounts WHERE workspace_id=$1`,[workspaceId])).rows[0]?.status,'PROVISIONING');
  const connection=(await db.query<{status:string;health_status:string}>(`SELECT status,health_status FROM provider_connections WHERE workspace_id=$1 AND provider_key='whatsapp'`,[workspaceId])).rows[0];
  assert.equal(connection?.status,'CONNECTING');
  assert.equal(connection?.health_status,'UNKNOWN');
  assert.equal((await db.query(`SELECT 1 FROM audit_log WHERE action='workspace.oauth_self_service_changed' AND workspace_id=$1`,[workspaceId])).rows.length,3);
});
it('exposes the active UnifyPort sender as the WhatsApp fallback after workspace approval',async()=>{
  const approvedWorkspace=(await db.query<{id:string}>(`INSERT INTO workspaces(name,created_by) VALUES('Approved WhatsApp',$1) RETURNING id`,[userId])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[approvedWorkspace,userId]);
  await adminOAuthRepo.setWorkspaceOAuthSelfServicePermission({workspaceId:approvedWorkspace,provider:'whatsapp',allowed:true,actorId:userId});
  await omniRepo.registerUnifyPortIdentity({workspaceId:null,accountId:'acc_admin_whatsapp_test',displayName:'Lulu Admin WhatsApp',phone:'+4917641474606',configuredBy:userId});
  const connection=await whatsappWorkspace.getWorkspaceWhatsAppConnection(approvedWorkspace);
  assert.equal(connection.selfServiceAllowed,true);
  assert.equal(connection.adminFallback.configured,true);
  assert.equal(connection.adminFallback.displayName,'Lulu Admin WhatsApp');
  assert.equal(connection.adminFallback.address,'+4917641474606');
});
it('shows real sites, runs, approvals, jobs and audit entries',async()=>{
  await db.query(`INSERT INTO workspace_sites(workspace_id,provider,ownership_mode,name) VALUES($1,'managed','managed','Customer site')`,[workspaceId]);
  await db.query(`INSERT INTO agent_runs(workspace_id,goal,status) VALUES($1,'Customer workflow','failed')`,[workspaceId]);
  await db.query(`INSERT INTO approval_requests(workspace_id,title,action_type) VALUES($1,'Approval','publish')`,[workspaceId]);
  await db.query(`INSERT INTO background_jobs(workspace_id,job_type,status) VALUES($1,'test','failed')`,[workspaceId]);
  assert.equal((await repo.listWebsites())[0]!.title,'Customer site');
  assert.equal((await repo.listAgents())[0]!.name,'Customer workflow');
  assert.equal((await repo.listApprovals())[0]!.approvalType,'publish');
  assert.equal((await repo.listJobs())[0]!.attempt,0);
  assert.equal((await repo.listErrorEvents()).length,2);
});
it('lists real customer uploads without exposing content or storage credentials',async()=>{
  await db.query(`INSERT INTO onboarding_documents(workspace_id,uploaded_by,file_name,mime_type,size_bytes,content) VALUES($1,$2,'customer.txt','text/plain',1,'x')`,[workspaceId,userId]);
  const files=await repo.listFiles();assert.equal(files[0]!.fileName,'customer.txt');
  assert.equal(files[0]!.content,undefined);assert.equal(files[0]!.storageKey,undefined);
  assert.equal((await repo.getUploadedFile('onboarding',files[0]!.id)).file_name,'customer.txt');
  await assert.rejects(()=>repo.getUploadedFile('../../.env',files[0]!.id));
  await assert.rejects(()=>repo.getUploadedFile('record',files[0]!.id));
});
it('keeps support history private to its requester and workspace; admin replies are audited',async()=>{
  const actor={workspaceId,userId};
  const ticket=await support.create(workspaceId,userId,{subject:'Billing help',body:'Cannot pay',category:'billing'});
  const otherUser='00000000-0000-0000-0000-000000000001';
  assert.equal((await support.list({...actor,userId:otherUser},50,0)).length,0);
  await assert.rejects(()=>support.detail({...actor,userId:otherUser},ticket.id));
  await assert.rejects(()=>support.respond({...actor,workspaceId:otherUser},ticket.id,{body:'Attack'}));
  await support.respond({adminId:userId},ticket.id,{body:'We are checking',status:'waiting_customer'});
  const detail=await support.detail(actor,ticket.id);
  assert.equal(detail.messages.length,2);assert.equal(detail.messages[1]!.authorType,'ADMIN');
  assert.equal((await repo.listAuditLogs()).some(r=>r.action==='support.updated'),true);
});
it('separates support read access from support mutation authority',()=>{
  assert.ok(capabilitiesForRoles(['SUPPORT_ADMIN']).includes('support.manage'));
  assert.ok(!capabilitiesForRoles(['READ_ONLY_ADMIN']).includes('support.manage'));
  assert.ok(!capabilitiesForRoles(['owner']).includes('support.read'));
});
it('propagates database failures instead of reporting a false empty state',async()=>{
  const failing=mock.method(pool,'query',async()=>{throw new Error('database unavailable');});
  try{await assert.rejects(()=>repo.listWebsites(),/database unavailable/);}finally{failing.mock.restore();}
});
