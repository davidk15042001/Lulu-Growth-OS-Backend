import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgres://test:test@127.0.0.1:1/security_tests_only';
process.env.JWT_SECRET='security-tests-only-not-a-production-key';
process.env.BCRYPT_ROUNDS='10';
process.env.PROVIDER_CREDENTIAL_KEY='42'.repeat(32);
const { pool }=await import('../src/db/pool.js');
const auth=await import('../src/modules/auth/auth.repo.js');
const service=await import('../src/modules/auth/auth.service.js');
const admin=await import('../src/modules/admin/admin.authorization.js');
const { createSecretBox }=await import('../src/utils/secret-box.js');
const { safeSecurityMetadata }=await import('../src/modules/security/security-event.service.js');
const { verifyToken }=await import('../src/utils/jwt.js');
const { checkDnsChallenge, verifyDomainOwnership }=await import('../src/modules/websites/domain-verification.service.js');
const website=await import('../src/modules/websites/website.repo.js');
const bcrypt=await import('bcryptjs');
const agentAuth=await import('../src/modules/agents/agent.authorization.js');
const { evaluateAgentActionPolicy, decideAgentToolPolicy }=await import('../src/modules/agents/agent.autonomy-policy.js');
const records=await import('../src/modules/records/record.repo.js');
const approvals=await import('../src/modules/approvals/approval.repo.js');
const { registerAgentExecutionHandlers }=await import('../src/modules/agents/agent-execution.worker.js');
const { registeredDomainEventHandlers }=await import('../src/events/domain-event.registry.js');
const { DOMAIN_EVENT_TYPES }=await import('../src/events/domain-event.types.js');
import type { AgentExecutionCommand } from '../src/modules/agents/agent.execution-command.js';
import type { DomainEvent } from '../src/events/domain-event.types.js';
const db=new PGlite();
const { RESOURCE_CATALOG }=await import('../src/domain/resource-catalog.js');
let passwordHash:string;
const legitimateAdmin='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roleOnlyAdmin='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

before(async()=>{
  passwordHash=await bcrypt.hash('Test-password-2026!',10);
  for(const file of (await readdir('src/database/migrations')).filter(name=>name.endsWith('.sql')).sort()) {
    if(file==='0034_security_foundation.sql') {
      await db.query(`INSERT INTO users(id,email,password_hash,role,verified_at) VALUES($1,'lulu.ai.cn@gmail.com',$3,'admin',NOW()),($2,'role-only@example.test',$3,'admin',NOW())`,[legitimateAdmin,roleOnlyAdmin,passwordHash]);
    }
    await db.exec(await readFile(`src/database/migrations/${file}`,'utf8'));
  }
  for(const resource of RESOURCE_CATALOG) await db.query('INSERT INTO resource_types(key,domain,label,description) VALUES($1,$2,$3,$4)',[resource.key,resource.domain,resource.label,resource.description]);
  const execute=async(sql:string,values:unknown[]=[])=>{const result=await db.query(sql,values);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length};};
  // Every repository call is directed to in-memory PostgreSQL, never a server.
  mock.method(pool,'query',execute as never);
  mock.method(pool,'connect',(async()=>({query:execute,release(){}})) as never);
});
after(async()=>{mock.restoreAll();await pool.end();await db.close();});

async function newUser(verified=false) {
  const email=`${crypto.randomUUID()}@example.test`;
  const user=await auth.createUnverifiedUser(email,passwordHash,'Test','User');
  if(verified) assert.deepEqual(await auth.consumeOtp(email,user.code,'verify_email'),{ok:true});
  return {...user,email};
}
const rotate=(token:string)=>{const [selector,validator]=token.split('.');return auth.rotateRefreshToken(selector!,validator!);};

describe('email verification security',()=>{
  it('new account stays unverified and cannot log in or open a session',async()=>{
    const user=await newUser();
    assert.equal((await auth.getUserById(user.id))?.verified_at,null);
    assert.deepEqual(await service.loginUser(user.email,'Test-password-2026!'),{unverified:true});
    await assert.rejects(auth.createAdditionalSession(user.id),{code:'ACCOUNT_UNVERIFIED'});
  });
  it('valid code verifies atomically, cannot be reused, and already verified is handled',async()=>{
    const user=await newUser();
    assert.deepEqual(await auth.consumeOtp(user.email,user.code,'verify_email'),{ok:true});
    assert.ok((await auth.getUserById(user.id))?.verified_at);
    assert.deepEqual(await auth.consumeOtp(user.email,user.code,'verify_email'),{used:true});
    assert.equal(await auth.issueOtp(user.id,'verify_email'),null);
    const events=await db.query(`SELECT event_type FROM security_events WHERE user_id=$1 AND event_type='EMAIL_VERIFIED'`,[user.id]);
    assert.equal(events.rows.length,1);
  });
  it('expired and invalid codes never verify; attempts are limited',async()=>{
    const expired=await newUser();
    await db.query(`UPDATE otp_codes SET expires_at=NOW()-INTERVAL '1 minute' WHERE user_id=$1`,[expired.id]);
    assert.deepEqual(await auth.consumeOtp(expired.email,expired.code,'verify_email'),{expired:true});
    const user=await newUser();
    const wrong=user.code==='000000'?'999999':'000000';
    for(let index=0;index<5;index++) assert.deepEqual(await auth.consumeOtp(user.email,wrong,'verify_email'),{invalid:true});
    assert.deepEqual(await auth.consumeOtp(user.email,user.code,'verify_email'),{invalid:true});
    assert.equal((await auth.getUserById(user.id))?.verified_at,null);
  });
  it('resend cooldown is persisted and replacement invalidates the previous code',async()=>{
    const user=await newUser();
    await assert.rejects(auth.issueOtp(user.id,'verify_email'),{code:'OTP_RESEND_RATE_LIMITED'});
    await db.query(`UPDATE otp_codes SET created_at=NOW()-INTERVAL '2 minutes' WHERE user_id=$1`,[user.id]);
    const code=await auth.issueOtp(user.id,'verify_email');
    assert.ok(code);
    const old=await db.query<{used:boolean}>('SELECT used FROM otp_codes WHERE user_id=$1 ORDER BY created_at LIMIT 1',[user.id]);
    assert.equal(old.rows[0]?.used,true);
    assert.deepEqual(await auth.consumeOtp(user.email,code,'verify_email'),{ok:true});
  });
});

describe('sessions and refresh families',()=>{
  it('login creates a short signed session without invalidating other logins',async()=>{
    const user=await newUser(true);
    const first=await service.loginUser(user.email,'Test-password-2026!',{userAgent:'Mozilla/5.0 Chrome/200 private-detail',ipAddress:'192.0.2.1'});
    assert.ok('ok' in first);
    const claims=verifyToken(first.token);
    assert.ok(claims.sid);
    const decoded=JSON.parse(Buffer.from(first.token.split('.')[1]!,'base64url').toString());
    assert.ok(decoded.exp-decoded.iat<=3600);
    await service.loginUser(user.email,'Test-password-2026!');
    const sessions=await auth.listSessions(user.id,claims.sid!);
    assert.equal(sessions.length,2);
    assert.ok(sessions.some(row=>row.deviceLabel==='Chrome'));
    assert.ok(!JSON.stringify(sessions).includes('192.0.2.1'));
  });
  it('rotation is single use, wrong validator cannot revoke, reuse revokes replacement too',async()=>{
    const user=await newUser(true);
    const first=await auth.createAdditionalSession(user.id);
    const second=await rotate(first.token);
    assert.equal(second.status,'rotated');
    assert.equal((await rotate(first.token.split('.')[0]+'.invalid')).status,'invalid');
    assert.equal((await auth.listSessions(user.id,first.sessionId)).length,1);
    assert.equal((await rotate(first.token)).status,'reused');
    if(second.status==='rotated') assert.equal((await rotate(second.refreshToken)).status,'invalid');
    assert.equal((await auth.listSessions(user.id,first.sessionId)).length,0);
    assert.equal((await db.query(`SELECT id FROM security_events WHERE user_id=$1 AND event_type='REFRESH_REUSE_DETECTED'`,[user.id])).rows.length,1);
  });
  it('individual and other-session revocation is user scoped',async()=>{
    const user=await newUser(true), stranger=await newUser(true);
    const a=await auth.createAdditionalSession(user.id), b=await auth.createAdditionalSession(user.id);
    assert.equal(await auth.revokeSession(stranger.id,a.sessionId),false);
    assert.equal(await auth.revokeSession(user.id,b.sessionId),true);
    assert.equal((await rotate(b.token)).status,'invalid');
    await auth.createAdditionalSession(user.id);
    await auth.revokeSessions(user.id,a.sessionId);
    assert.equal((await auth.listSessions(user.id,a.sessionId)).length,1);
    assert.equal((await rotate(a.token)).status,'rotated');
  });
  it('expired refresh fails and absolute family expiry never slides',async()=>{
    const user=await newUser(true);
    const first=await auth.createAdditionalSession(user.id);
    const result=await rotate(first.token);
    assert.equal(result.status,'rotated');
    const rows=await db.query<{expires_at:Date}>('SELECT expires_at FROM refresh_tokens WHERE session_id=$1',[first.sessionId]);
    assert.equal(new Set(rows.rows.map(row=>new Date(row.expires_at).getTime())).size,1);
    await db.query(`UPDATE auth_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,[first.sessionId]);
    if(result.status==='rotated') assert.equal((await rotate(result.refreshToken)).status,'expired');
  });
});

describe('admin capabilities and security audit',()=>{
  it('only previously authorized administrator is migrated',async()=>{
    assert.ok((await admin.getAdminCapabilities(legitimateAdmin)).includes('users.impersonate'));
    assert.deepEqual(await admin.getAdminCapabilities(roleOnlyAdmin),[]);
    await assert.rejects(admin.assertAdminCapability(roleOnlyAdmin,'users.manage'),{code:'ADMIN_CAPABILITY_REQUIRED'});
  });
  it('finance and read-only roles do not gain security or write powers',async()=>{
    await db.query(`INSERT INTO admin_user_roles(user_id,role) VALUES($1,'FINANCE_ADMIN')`,[roleOnlyAdmin]);
    await admin.assertAdminCapability(roleOnlyAdmin,'billing.manage');
    await assert.rejects(admin.assertAdminCapability(roleOnlyAdmin,'security.manage'),{code:'ADMIN_CAPABILITY_REQUIRED'});
    assert.ok(!admin.capabilitiesForRoles(['READ_ONLY_ADMIN']).some(value=>value.endsWith('.manage')));
  });
  it('events are append-only and do not accept secret metadata',async()=>{
    assert.deepEqual(safeSecurityMetadata({password:'secret',accessToken:'secret',providerToken:'secret',code:'123456',action:'test',nested:{secret:'x'}}),{action:'test'});
    await assert.rejects(db.query(`UPDATE security_events SET metadata='{}' WHERE user_id=$1`,[legitimateAdmin]),/append-only/);
    const rows=await db.query('SELECT metadata FROM security_events');
    assert.ok(!JSON.stringify(rows.rows).includes(passwordHash));
  });
});

describe('provider key separation',()=>{
  const legacySecret='old-jwt-secret-at-least-thirty-two-characters';
  const key='ab'.repeat(32);
  const box=createSecretBox({currentKey:key,version:'2',legacySecret});
  it('authenticated encryption roundtrips, randomizes and rejects tampering without leaking secrets',()=>{
    const encrypted=box.encrypt('provider-token-value');
    assert.ok(encrypted.startsWith('v2.2.'));
    assert.equal(box.decrypt(encrypted),'provider-token-value');
    assert.notEqual(box.encrypt('provider-token-value'),encrypted);
    assert.ok(!encrypted.includes('provider-token-value'));
    const parts=encrypted.split('.');parts[4]=Buffer.from('tamper').toString('base64url');
    assert.throws(()=>box.decrypt(parts.join('.')),/^Error: Provider credential could not be decrypted$/);
    assert.throws(()=>createSecretBox({currentKey:crypto.createHash('sha256').update(legacySecret).digest('hex'),version:'1',legacySecret}),/independent/);
  });
  it('decrypts legacy v1 and previous v2 keys while new writes only use the dedicated key',()=>{
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(legacySecret).digest(),iv);
    const data=Buffer.concat([cipher.update('legacy-token'),cipher.final()]);
    const legacy=['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');
    assert.equal(box.decrypt(legacy),'legacy-token');assert.equal(box.needsRotation(legacy),true);
    const next=createSecretBox({currentKey:'cd'.repeat(32),version:'3',previousKeys:{'2':key},legacySecret});
    assert.equal(next.decrypt(box.encrypt('test')),'test');
    assert.throws(()=>createSecretBox({version:'1',legacySecret}).encrypt('new'),/must be configured/);
  });
});

describe('DNS ownership proof',()=>{
  const future=new Date(Date.now()+60_000).toISOString();
  it('requires the exact TXT challenge, supports chunked TXT, and fails closed on DNS errors',async()=>{
    assert.equal(await checkDnsChallenge('example.test','lulu-site=abc',future,async name=>{assert.equal(name,'_lulu-verification.example.test');return [['lulu-site=','abc']];}),null);
    assert.equal(await checkDnsChallenge('example.test','abc',future,async()=>[]),'DNS_CHALLENGE_NOT_FOUND');
    assert.equal(await checkDnsChallenge('example.test','abc',future,async()=>[['wrong']]),'DNS_CHALLENGE_NOT_FOUND');
    assert.equal(await checkDnsChallenge('example.test','abc',future,async()=>{throw new Error('dns');}),'DNS_LOOKUP_FAILED');
    assert.equal(await checkDnsChallenge('example.test','abc',new Date(0).toISOString(),async()=>{throw new Error('must not resolve');}),'DNS_CHALLENGE_EXPIRED');
  });
  it('persists verified state and security event only for the correct tenant, idempotently',async()=>{
    const user=await newUser(true);
    const ws=(await db.query<{id:string}>(`INSERT INTO workspaces(name,created_by) VALUES('Test',$1) RETURNING id`,[user.id])).rows[0]!;
    const site=await website.createSite({workspaceId:ws.id,provider:'managed',ownershipMode:'managed',name:'Test'});
    assert.ok(site);
    const domain=await website.createDomain(site.id,'example.test');
    const context={workspaceId:ws.id,siteId:site.id,domainId:domain.id,userId:user.id};
    await assert.rejects(verifyDomainOwnership({...context,workspaceId:crypto.randomUUID()},async()=>{throw new Error('must not query DNS');}),{code:'WEBSITE_DOMAIN_NOT_FOUND'});
    const result=await verifyDomainOwnership(context,async()=>[[domain.verificationToken]]);
    assert.equal(result?.domains[0]?.status,'verified');
    await verifyDomainOwnership(context,async()=>{throw new Error('must not query twice');});
    assert.equal((await db.query(`SELECT id FROM security_events WHERE event_type='DOMAIN_VERIFIED' AND workspace_id=$1`,[ws.id])).rows.length,1);
  });
});

async function agentFixture(type:AgentExecutionCommand['type']='crm.create_followup_task') {
  const user=await newUser(true);
  const ws=(await db.query<{id:string}>(`INSERT INTO workspaces(name,created_by) VALUES('Agent test',$1) RETURNING id`,[user.id])).rows[0]!;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[ws.id,user.id]);
  await db.query(`INSERT INTO workspace_subscriptions(workspace_id,plan_key,status) VALUES($1,'test','active')`,[ws.id]);
  const run=(await db.query<{id:string}>(`INSERT INTO agent_runs(workspace_id,created_by,goal,status,plan) VALUES($1,$2,'Test','running','{"module":"crm"}') RETURNING id`,[ws.id,user.id])).rows[0]!;
  const step=(await db.query<{id:string}>(`INSERT INTO agent_run_steps(run_id,workspace_id,sequence_no,agent_role,title,instruction,tool_name) VALUES($1,$2,1,'executor','Test','Test','page_action_writeback') RETURNING id`,[run.id,ws.id])).rows[0]!;
  const context={workspaceId:ws.id,userId:user.id,runId:run.id,stepId:step.id};
  const command:AgentExecutionCommand={type,summary:'Test operation',targetSystem:'crm',provider:null,riskLevel:'low',approvalPolicy:'allow',targetEntityType:null,targetEntityId:null,payload:{},idempotencyKey:crypto.randomUUID()};
  const record=await records.createRecord(ws.id,'crm_tasks',user.id,{name:'Test packet',source:'page_agent',stage:'waiting_approval',data:{commands:[command],module:'crm',budgetProtected:false,executionReady:false}});
  return {context,record,command,user};
}

describe('deterministic agent execution authorization',()=>{
  it('autonomous mode cannot bypass financial, external, budget or prohibited classes',()=>{
    for(const action of ['finance.create_automation','website.publish_job','google_reviews.reply','advertising.create_optimization']) assert.equal(evaluateAgentActionPolicy(action,true).decision,'require_approval');
    assert.equal(evaluateAgentActionPolicy('crm.create_followup_task',true,{budgetProtected:true}).decision,'require_approval');
    assert.equal(evaluateAgentActionPolicy('payments.transfer',true).autonomyClass,'PROHIBITED');
    assert.equal(evaluateAgentActionPolicy('payments.transfer',true).decision,'forbidden');
    assert.equal(decideAgentToolPolicy({name:'payments.transfer',version:'1',risk:'financial',autonomy:'always_safe',description:'fake',execute:async()=>({})},true,'approved'),'forbidden');
  });
  it('allows a verified entitled actor and refuses cross-tenant tools before dispatch',async()=>{
    const f=await agentFixture();
    assert.equal((await agentAuth.authorizeAgentTool(f.context,'page_action_writeback')).decision,'allow');
    await agentAuth.registerAgentActionPacket(f.context,f.record,[f.command]);
    let executed=0;
    await agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],async()=>{executed++;});
    assert.equal(executed,1);
    await assert.rejects(agentAuth.authorizeAgentTool({...f.context,workspaceId:crypto.randomUUID()},'page_action_writeback'),{code:'AGENT_EXECUTION_FORBIDDEN'});
    await db.query(`UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1`,[f.context.workspaceId]);
    await assert.rejects(agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],async()=>{executed++;}),{code:'AGENT_EXECUTION_FORBIDDEN'});
    assert.equal(executed,1);
  });
  it('requires a human backend approval bound to the exact packet and consumes it once',async()=>{
    const f=await agentFixture('google_reviews.reply');
    const packet=await agentAuth.registerAgentActionPacket(f.context,f.record,[f.command]);
    assert.ok(packet.approvalId);
    let executed=0;
    f.record.data={...f.record.data,approvalDecision:'approved',approvedBy:f.user.id};
    await assert.rejects(agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],async()=>{executed++;}),{code:'AGENT_EXECUTION_FORBIDDEN'});
    assert.equal(executed,0);
    const member=await newUser(true);
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')`,[f.context.workspaceId,member.id]);
    assert.equal(await approvals.decideApproval(f.context.workspaceId,packet.approvalId,member.id,true,{decision:'approved'}),undefined);
    assert.ok(await approvals.decideApproval(f.context.workspaceId,packet.approvalId,f.user.id,true,{decision:'approved'}));
    await agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],async()=>{executed++;});
    assert.equal(executed,1);
    await assert.rejects(agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],async()=>{executed++;}),{code:'AGENT_EXECUTION_FORBIDDEN'});
    assert.equal(executed,1);
  });
  it('rejects forged, tampered, prohibited and no-longer-entitled packets without side effects',async()=>{
    const f=await agentFixture();
    let executed=0;
    const dispatch=async()=>{executed++;};
    await assert.rejects(agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],dispatch),{code:'AGENT_EXECUTION_FORBIDDEN'});
    const prohibited={...f.command,type:'payments.transfer'} as unknown as AgentExecutionCommand;
    await assert.rejects(agentAuth.registerAgentActionPacket(f.context,f.record,[prohibited]),{code:'AGENT_EXECUTION_FORBIDDEN'});
    await agentAuth.registerAgentActionPacket(f.context,f.record,[f.command]);
    const changed={...f.command,payload:{amount:50000}};
    await assert.rejects(agentAuth.executeAuthorizedAgentPacket({...f.record,data:{...f.record.data,commands:[changed]}},[changed],dispatch),{code:'AGENT_EXECUTION_FORBIDDEN'});
    await db.query(`UPDATE workspace_subscriptions SET status='paused' WHERE workspace_id=$1`,[f.context.workspaceId]);
    await assert.rejects(agentAuth.executeAuthorizedAgentPacket(f.record,[f.command],dispatch),{code:'AGENT_EXECUTION_FORBIDDEN'});
    assert.equal(executed,0);
  });
  it('event-triggered worker executes the same guard and rejects public-record forgeries',async()=>{
    // Keep unrelated fixtures out of this worker cycle.
    await db.query(`UPDATE workspace_records SET stage='test_complete' WHERE source='page_agent'`);
    const f=await agentFixture('google_reviews.reply');
    await db.query(`UPDATE workspace_records SET stage='queued_for_execution',data=data||'{"executionReady":true}'::jsonb WHERE id=$1`,[f.record.id]);
    registerAgentExecutionHandlers();
    const handler=registeredDomainEventHandlers().find(h=>h.name==='agents.execution-record-wakeup.v1');
    assert.ok(handler);
    await handler.handle({type:DOMAIN_EVENT_TYPES.RECORD_CREATED,workspaceId:f.context.workspaceId,aggregateId:f.record.id} as DomainEvent);
    const record=await records.findRecord(f.context.workspaceId,'crm_tasks',f.record.id);
    assert.equal(record?.stage,'execution_failed');
    assert.match(String(record?.data?.executionError),/untrusted_action_packet/);
    assert.equal((await db.query(`SELECT id FROM workspace_records WHERE source='agent_executor' AND workspace_id=$1`,[f.context.workspaceId])).rows.length,0);
  });
});
