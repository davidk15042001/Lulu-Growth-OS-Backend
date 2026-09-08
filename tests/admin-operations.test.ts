import assert from 'node:assert/strict';
import { before, after, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgres://test:test@127.0.0.1:1/admin_ops';
process.env.JWT_SECRET='admin-operations-tests-secret-0123456789';
const {pool}=await import('../src/db/pool.js');
const repo=await import('../src/modules/admin/admin.repo.js');
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
});
after(async()=>{mock.restoreAll();await pool.end();await db.close();});
it('executes every admin operational query against the actual migrated schema',async()=>{
  for(const load of [repo.listWebsites,repo.listAgents,repo.listIntegrations,repo.listApprovals,repo.listErrorEvents,repo.listAuditLogs,repo.listConversations,repo.listFiles,repo.listJobs]) assert.ok(Array.isArray(await load()));
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
