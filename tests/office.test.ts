import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/office_tests_only';
process.env.JWT_SECRET = 'office-tests-only-not-a-production-key';

const { pool } = await import('../src/db/pool.js');
const officeRepo = await import('../src/modules/office/office.repo.js');
const officeService = await import('../src/modules/office/office.service.js');
const agentRepo = await import('../src/modules/agents/agent.repo.js');
const agentService = await import('../src/modules/agents/agent.service.js');
const { createApp } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { ROLE_CAPABILITIES } = await import('../src/modules/workspaces/workspace-permissions.js');
const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
});

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

async function fixture(name = 'Office Company') {
  const owner = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@office.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by,onboarding_step,onboarding_completed_at,profile_completed_at,knowledge_base_completed_at)
     VALUES($1,$2,'setup_complete',NOW(),NOW(),NOW()) RETURNING id`, [name, owner],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, owner]);
  await db.query(`INSERT INTO workspace_subscriptions(workspace_id,plan_key,status,provider)
    VALUES($1,'ai','active','internal')`, [workspaceId]);
  const sessionId = (await db.query<{ id: string }>(
    `INSERT INTO auth_sessions(user_id,expires_at) VALUES($1,NOW()+INTERVAL '1 hour') RETURNING id`, [owner],
  )).rows[0]!.id;
  const email = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [owner])).rows[0]!.email;
  const token = signToken({ sub: owner, email, tv: 0, sid: sessionId });
  return { workspaceId, owner, token };
}

async function addWorkspaceMember(workspaceId: string, role: 'viewer' | 'member' | 'marketing_manager') {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@office-member.test`],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)`, [workspaceId,id,role]);
  const sessionId = (await db.query<{ id: string }>(
    `INSERT INTO auth_sessions(user_id,expires_at) VALUES($1,NOW()+INTERVAL '1 hour') RETURNING id`, [id],
  )).rows[0]!.id;
  const email = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [id])).rows[0]!.email;
  return { id, token: signToken({ sub:id,email,tv:0,sid:sessionId }) };
}

async function createRun(workspaceId: string, owner: string, module = 'sales', status = 'queued') {
  return (await db.query<{ id: string }>(`INSERT INTO agent_runs(workspace_id,created_by,goal,status,plan)
    VALUES($1,$2,'Handle a real customer opportunity',$3,$4::jsonb) RETURNING id`, [
    workspaceId, owner, status, JSON.stringify({
      version: 4,
      module,
      agentDefinition: { id: 'page:test-sales', name: 'Sales specialist', module, tier: 'specialist' },
      page: { pageId: 'sales-follow-ups', pageLabel: 'Sales Follow-ups' },
    }),
  ])).rows[0]!.id;
}

describe('Digital Company Office foundation', () => {
  it('materializes only real supported employee roles and keeps an empty office idle', async () => {
    const f = await fixture();
    const overview = await officeService.getOverview(f.workspaceId, 24, { capabilities: ROLE_CAPABILITIES.owner });
    assert.equal(overview.timelineScope,'recent');
    assert.equal(overview.summary.departmentCount, 9);
    assert.equal(overview.summary.employeeCount, 29);
    assert.equal(overview.summary.activeEmployees, 0);
    assert.ok(overview.departments.every((department) => department.employees.length > 0));
    assert.ok(overview.departments.flatMap((department) => department.employees)
      .every((employee) => employee.status === 'IDLE' && employee.availability !== 'UNAVAILABLE'));
  });

  it('materializes complete execution capabilities for each canonical employee role', async () => {
    const f = await fixture();
    const rows = await db.query<{ employeeKey: string; capabilityKey: string; accessMode: string }>(`
      SELECT e.employee_key AS "employeeKey", c.capability_key AS "capabilityKey", c.access_mode AS "accessMode"
      FROM digital_employee_capabilities c
      JOIN digital_employees e ON e.workspace_id=c.workspace_id AND e.id=c.employee_id
      WHERE c.workspace_id=$1
        AND e.employee_key = ANY($2::text[])
        AND c.capability_key = ANY($3::text[])
      ORDER BY e.employee_key,c.capability_key`, [f.workspaceId,
      ['quote-specialist','invoice-manager','website-manager','product-manager','integration-manager','outcome-quality-auditor'],
      ['quotes.send','invoices.issue','invoices.send','website.publish','products.create','providers.connect','quality.review']]);
    const capabilities = new Set(rows.rows.map((row) => `${row.employeeKey}:${row.capabilityKey}:${row.accessMode}`));
    for (const expected of [
      'quote-specialist:quotes.send:EXECUTE',
      'invoice-manager:invoices.issue:EXECUTE',
      'invoice-manager:invoices.send:EXECUTE',
      'website-manager:website.publish:EXECUTE',
      'product-manager:products.create:EXECUTE',
      'integration-manager:providers.connect:EXECUTE',
      'outcome-quality-auditor:quality.review:EXECUTE',
    ]) assert.ok(capabilities.has(expected), `missing ${expected}`);
  });

  it('derives employee state from a real persisted agent run', async () => {
    const f = await fixture();
    const runId = await createRun(f.workspaceId, f.owner);
    let item = (await db.query<{ id: string; status: string; employeeKey: string }>(`
      SELECT wi.id,wi.status,e.employee_key AS "employeeKey"
      FROM office_work_items wi JOIN digital_employees e ON e.id=wi.primary_employee_id
      WHERE wi.workspace_id=$1 AND wi.source_agent_run_id=$2`, [f.workspaceId, runId])).rows[0]!;
    assert.equal(item.status, 'queued');
    assert.equal(item.employeeKey, 'follow-up-specialist');

    await db.query(`UPDATE agent_runs SET status='running',started_at=NOW() WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, runId]);
    let projection = (await db.query<{ displayState: string }>(`
      SELECT p.display_state AS "displayState" FROM office_employee_state_projection p
      JOIN office_work_items wi ON wi.workspace_id=p.workspace_id AND wi.primary_employee_id=p.employee_id
      WHERE wi.id=$1`, [item.id])).rows[0]!;
    assert.equal(projection.displayState, 'WORKING');

    await db.query(`UPDATE agent_runs SET status='completed',result='{"verified":true}'::jsonb,finished_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, runId]);
    item = (await db.query<{ id: string; status: string; employeeKey: string }>(`
      SELECT wi.id,wi.status,e.employee_key AS "employeeKey"
      FROM office_work_items wi JOIN digital_employees e ON e.id=wi.primary_employee_id
      WHERE wi.workspace_id=$1 AND wi.source_agent_run_id=$2`, [f.workspaceId, runId])).rows[0]!;
    assert.equal(item.status, 'completed');
    projection = (await db.query<{ displayState: string }>(`
      SELECT display_state AS "displayState" FROM office_employee_state_projection
      WHERE workspace_id=$1 AND employee_id=(SELECT primary_employee_id FROM office_work_items WHERE id=$2)`,
    [f.workspaceId, item.id])).rows[0]!;
    assert.equal(projection.displayState, 'IDLE');
  });

  it('keeps repeated roster ensures JSON-idempotent without duplicate source agents', async () => {
    const f = await fixture();
    await officeRepo.ensureOfficeRoster(f.workspaceId);
    const first = (await db.query<{ source: string; length: number }>(
      `SELECT source_agent_ids::text AS source,jsonb_array_length(source_agent_ids)::int AS length
       FROM digital_employees WHERE workspace_id=$1 AND employee_key='invoice-manager'`,
      [f.workspaceId],
    )).rows[0]!;
    await officeRepo.ensureOfficeRoster(f.workspaceId);
    await officeRepo.ensureOfficeRoster(f.workspaceId);
    const repeated = (await db.query<{ source: string; length: number }>(
      `SELECT source_agent_ids::text AS source,jsonb_array_length(source_agent_ids)::int AS length
       FROM digital_employees WHERE workspace_id=$1 AND employee_key='invoice-manager'`,
      [f.workspaceId],
    )).rows[0]!;
    assert.deepEqual(repeated, first);
    assert.equal(repeated.length, 1);
    assert.deepEqual(JSON.parse(repeated.source), ['page:breezy-soil-2475']);
  });

  it('never presents an unavailable employee as working', async () => {
    const f = await fixture();
    const runId = await createRun(f.workspaceId, f.owner, 'sales', 'running');
    const item = (await db.query<{ id: string; employeeId: string }>(`SELECT id,primary_employee_id AS "employeeId"
      FROM office_work_items WHERE workspace_id=$1 AND source_agent_run_id=$2`, [f.workspaceId,runId])).rows[0]!;
    await db.query(`UPDATE digital_employees SET availability='UNAVAILABLE' WHERE workspace_id=$1 AND id=$2`,
    [f.workspaceId,item.employeeId]);
    const state = (await db.query<{ state: string }>(`SELECT display_state AS state
      FROM office_employee_state_projection WHERE workspace_id=$1 AND employee_id=$2`,
    [f.workspaceId,item.employeeId])).rows[0]!.state;
    assert.equal(state, 'OFFLINE');
  });

  it('shows collaboration only while another persisted agent step is actually active', async () => {
    const f = await fixture();
    const runId = await createRun(f.workspaceId, f.owner, 'sales', 'running');
    const stepId = (await db.query<{ id: string }>(`INSERT INTO agent_run_steps(
      run_id,workspace_id,sequence_no,agent_role,title,instruction,status,agent_id,idempotency_key
    ) VALUES($1,$2,1,'reviewer','Policy review','Review policy','running','system:security-auditor','collaboration-step')
    RETURNING id`, [runId,f.workspaceId])).rows[0]!.id;
    const states = await db.query<{ key: string; state: string }>(`SELECT e.employee_key AS key,p.display_state AS state
      FROM digital_employees e JOIN office_employee_state_projection p
        ON p.workspace_id=e.workspace_id AND p.employee_id=e.id
      WHERE e.workspace_id=$1 AND e.employee_key IN ('follow-up-specialist','security-policy-auditor')
      ORDER BY e.employee_key`, [f.workspaceId]);
    assert.deepEqual(states.rows, [
      { key:'follow-up-specialist',state:'COLLABORATING' },
      { key:'security-policy-auditor',state:'COLLABORATING' },
    ]);
    await db.query(`UPDATE agent_run_steps SET status='completed',finished_at=NOW() WHERE id=$1`, [stepId]);
    const reviewerProjection = (await db.query<{ state: string; active: number }>(`SELECT p.display_state AS state,
        p.active_work_count::int AS active
      FROM digital_employees e JOIN office_employee_state_projection p
        ON p.workspace_id=e.workspace_id AND p.employee_id=e.id
      WHERE e.workspace_id=$1 AND e.employee_key='security-policy-auditor'`, [f.workspaceId])).rows[0]!;
    assert.deepEqual(reviewerProjection,{state:'IDLE',active:0});
  });

  it('attributes a delegated specialist to its own Digital Employee instead of the parent page role', async () => {
    const f = await fixture();
    const runId = (await db.query<{ id: string }>(`INSERT INTO agent_runs(workspace_id,created_by,goal,status,plan)
      VALUES($1,$2,'Prepare a verified quote','running',$3::jsonb) RETURNING id`, [
      f.workspaceId,
      f.owner,
      JSON.stringify({
        version:5,
        module:'sales',
        agentDefinition:{id:'page:tender-creek-3139',name:'Quote specialist',module:'sales',tier:'specialist'},
        page:{pageId:'tender-creek-3139',pageLabel:'Quotes'},
      }),
    ])).rows[0]!.id;
    await db.query(`INSERT INTO workspace_agent_performance(
        workspace_id,agent_id,agent_name,module,tier,selection_count
      ) VALUES($1,'page:nicely-ocean-1051','Product specialist','commerce','specialist',1)`, [f.workspaceId]);
    await db.query(`INSERT INTO agent_run_steps(
        run_id,workspace_id,sequence_no,agent_role,title,instruction,status,agent_id,idempotency_key
      ) VALUES($1,$2,1,'strategist','Product handoff','Match products','running',
        'page:nicely-ocean-1051','delegated-commerce-specialist')`, [runId,f.workspaceId]);
    const assignments = await db.query<{ key: string; role: string; completedAt: string | null }>(`
      SELECT employee.employee_key AS key,assignment.assignment_role AS role,
        assignment.completed_at AS "completedAt"
      FROM office_work_item_assignments assignment
      JOIN digital_employees employee
        ON employee.workspace_id=assignment.workspace_id AND employee.id=assignment.employee_id
      JOIN office_work_items work_item
        ON work_item.workspace_id=assignment.workspace_id AND work_item.id=assignment.work_item_id
      WHERE work_item.workspace_id=$1 AND work_item.source_agent_run_id=$2
      ORDER BY assignment.assignment_role`, [f.workspaceId,runId]);
    assert.deepEqual(assignments.rows.map((row) => ({key:row.key,role:row.role,completedAt:row.completedAt})), [
      {key:'product-manager',role:'CONTRIBUTOR',completedAt:null},
      {key:'follow-up-specialist',role:'PRIMARY',completedAt:null},
    ]);
  });

  it('keeps a completed reasoning run active until its real action packet finishes', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO resource_types(key,domain,label) VALUES('office_action','ai','Office action') ON CONFLICT DO NOTHING`);
    const runId = await createRun(f.workspaceId, f.owner);
    const stepId = (await db.query<{ id: string }>(`INSERT INTO agent_run_steps(
      run_id,workspace_id,sequence_no,agent_role,title,instruction,agent_id,idempotency_key
    ) VALUES($1,$2,1,'executor','Execute','Execute safely','page:test-sales','office-step') RETURNING id`,
    [runId, f.workspaceId])).rows[0]!.id;
    const recordId = (await db.query<{ id: string }>(`INSERT INTO workspace_records(
      workspace_id,resource_type,name,status,stage,source,data,created_by
    ) VALUES($1,'office_action','Send customer follow-up','approved','queued_for_execution','page_agent',
      '{"executionReady":true,"executionStatus":"queued","goal":"Send customer follow-up"}'::jsonb,$2) RETURNING id`,
    [f.workspaceId, f.owner])).rows[0]!.id;
    await db.query(`INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest)
      VALUES($1,$2,$3,$4,$5,$6)`, [recordId, f.workspaceId, runId, stepId, f.owner, 'digest']);
    await db.query(`UPDATE agent_runs SET status='completed',result='{"reasoningVerified":true}'::jsonb,finished_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, runId]);

    const parent = (await db.query<{ id: string; status: string }>(`SELECT id,status FROM office_work_items
      WHERE workspace_id=$1 AND source_type='agent_run' AND source_agent_run_id=$2`, [f.workspaceId, runId])).rows[0]!;
    let child = (await db.query<{ id: string; status: string; parentId: string }>(`SELECT id,status,parent_work_item_id AS "parentId"
      FROM office_work_items WHERE workspace_id=$1 AND source_type='agent_action_packet' AND source_record_id=$2`,
    [f.workspaceId, recordId])).rows[0]!;
    assert.equal(parent.status, 'waiting');
    assert.equal(child.status, 'queued');
    assert.equal(child.parentId, parent.id);
    const parentWhileChildActive = await officeRepo.findWorkItem(f.workspaceId,parent.id);
    assert.ok(!parentWhileChildActive?.availableControls?.includes('cancel'));

    await db.query(`UPDATE workspace_records SET stage='executing',
      data=data||'{"executionStatus":"executing","executionAttempts":1,"executionStartedAt":"2026-09-13T08:00:00.000Z"}'::jsonb,
      version=version+1 WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, recordId]);
    child = (await db.query<{ id: string; status: string; parentId: string }>(`SELECT id,status,parent_work_item_id AS "parentId"
      FROM office_work_items WHERE workspace_id=$1 AND source_record_id=$2`, [f.workspaceId, recordId])).rows[0]!;
    assert.equal(child.status, 'running');
    const working = (await db.query<{ state: string }>(`SELECT display_state AS state FROM office_employee_state_projection
      WHERE workspace_id=$1 AND employee_id=(SELECT primary_employee_id FROM office_work_items WHERE id=$2)`,
    [f.workspaceId, child.id])).rows[0]!;
    assert.equal(working.state, 'WORKING');

    await db.query(`UPDATE workspace_records SET stage='executed',status='completed',
      data=data||'{"executionStatus":"executed","executionCompletedAt":"2026-09-13T08:01:00.000Z","executionSummary":"Message sent","resultRecords":[]}'::jsonb,
      version=version+1 WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, recordId]);
    const terminal = await db.query<{ sourceType: string; status: string }>(`SELECT source_type AS "sourceType",status
      FROM office_work_items WHERE workspace_id=$1 AND id IN ($2,$3) ORDER BY source_type`,
    [f.workspaceId, parent.id, child.id]);
    assert.deepEqual(terminal.rows.map((row) => row.status), ['completed', 'completed']);
    const attempts = await db.query<{ status: string }>(`SELECT status FROM office_work_item_attempts
      WHERE workspace_id=$1 AND work_item_id=$2`, [f.workspaceId, child.id]);
    assert.deepEqual(attempts.rows.map((row) => row.status), ['succeeded']);
  });

  it('clears a recovered downstream failure from the parent employee work item', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO resource_types(key,domain,label) VALUES('office_action','ai','Office action') ON CONFLICT DO NOTHING`);
    const runId = await createRun(f.workspaceId,f.owner);
    const stepId = (await db.query<{ id: string }>(`INSERT INTO agent_run_steps(
      run_id,workspace_id,sequence_no,agent_role,title,instruction,agent_id,idempotency_key
    ) VALUES($1,$2,1,'executor','Execute','Execute safely','page:test-sales','office-recovery-step') RETURNING id`,
    [runId,f.workspaceId])).rows[0]!.id;
    const recordId = (await db.query<{ id: string }>(`INSERT INTO workspace_records(
      workspace_id,resource_type,name,status,stage,source,data,created_by
    ) VALUES($1,'office_action','Send customer follow-up','approved','queued_for_execution','page_agent',
      '{"executionReady":true,"executionStatus":"queued"}'::jsonb,$2) RETURNING id`,
    [f.workspaceId,f.owner])).rows[0]!.id;
    await db.query(`INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest)
      VALUES($1,$2,$3,$4,$5,'digest')`, [recordId,f.workspaceId,runId,stepId,f.owner]);
    await db.query(`UPDATE agent_runs SET status='completed',finished_at=NOW() WHERE workspace_id=$1 AND id=$2`,
    [f.workspaceId,runId]);

    await db.query(`UPDATE workspace_records SET stage='execution_failed',status='failed',
      data=data||'{"executionStatus":"failed","executionAttempts":1,"executionError":"Provider unavailable"}'::jsonb,
      version=version+1 WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,recordId]);
    const failedParent = (await db.query<{ status: string; errorCode: string | null }>(`SELECT status,error_code AS "errorCode"
      FROM office_work_items WHERE workspace_id=$1 AND source_type='agent_run' AND source_agent_run_id=$2`,
    [f.workspaceId,runId])).rows[0]!;
    assert.deepEqual(failedParent,{status:'failed',errorCode:'AGENT_ACTION_PACKET_FAILED'});

    await db.query(`UPDATE workspace_records SET stage='queued_for_execution',status='approved',
      data=data||'{"executionStatus":"queued","executionReady":true}'::jsonb,version=version+1
      WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,recordId]);
    const retriedParent = (await db.query<{ status: string; errorCode: string | null; errorMessage: string | null }>(`
      SELECT status,error_code AS "errorCode",error_message AS "errorMessage" FROM office_work_items
      WHERE workspace_id=$1 AND source_type='agent_run' AND source_agent_run_id=$2`,[f.workspaceId,runId])).rows[0]!;
    assert.deepEqual(retriedParent,{status:'waiting',errorCode:null,errorMessage:null});

    await db.query(`UPDATE workspace_records SET stage='executed',status='active',
      data=data||'{"executionStatus":"executed","executionCompletedAt":"2026-09-13T08:00:00.000Z"}'::jsonb,
      version=version+1 WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,recordId]);
    const completedParent = (await db.query<{ status: string; errorCode: string | null }>(`SELECT status,error_code AS "errorCode"
      FROM office_work_items WHERE workspace_id=$1 AND source_type='agent_run' AND source_agent_run_id=$2`,
    [f.workspaceId,runId])).rows[0]!;
    assert.deepEqual(completedParent,{status:'completed',errorCode:null});
  });

  it('never reports a completed parent when its real downstream action was cancelled', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO resource_types(key,domain,label) VALUES('office_action','ai','Office action') ON CONFLICT DO NOTHING`);
    const runId = await createRun(f.workspaceId,f.owner);
    const stepId = (await db.query<{ id: string }>(`INSERT INTO agent_run_steps(
      run_id,workspace_id,sequence_no,agent_role,title,instruction,agent_id,idempotency_key
    ) VALUES($1,$2,1,'executor','Execute','Execute safely','page:test-sales','office-cancelled-step') RETURNING id`,
    [runId,f.workspaceId])).rows[0]!.id;
    const recordId = (await db.query<{ id: string }>(`INSERT INTO workspace_records(
      workspace_id,resource_type,name,status,stage,source,data,created_by
    ) VALUES($1,'office_action','Send customer follow-up','approved','queued_for_execution','page_agent',
      '{"executionReady":true,"executionStatus":"queued"}'::jsonb,$2) RETURNING id`,
    [f.workspaceId,f.owner])).rows[0]!.id;
    await db.query(`INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest)
      VALUES($1,$2,$3,$4,$5,'digest')`, [recordId,f.workspaceId,runId,stepId,f.owner]);
    await db.query(`UPDATE agent_runs SET status='completed',finished_at=NOW() WHERE workspace_id=$1 AND id=$2`,
    [f.workspaceId,runId]);
    await db.query(`UPDATE workspace_records SET stage='execution_cancelled',status='cancelled',
      data=data||'{"executionStatus":"cancelled"}'::jsonb,version=version+1
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId,recordId]);
    const states = await db.query<{ sourceType: string; status: string }>(`SELECT source_type AS "sourceType",status
      FROM office_work_items WHERE workspace_id=$1 AND source_agent_run_id=$2 ORDER BY source_type`,
    [f.workspaceId,runId]);
    assert.deepEqual(states.rows,[
      {sourceType:'agent_action_packet',status:'cancelled'},
      {sourceType:'agent_run',status:'cancelled'},
    ]);
  });

  it('enforces tenant-safe dependencies and rejects dependency cycles', async () => {
    const a = await fixture('Office A');
    const b = await fixture('Office B');
    const employeeA = (await db.query<{ id: string }>(`SELECT id FROM digital_employees
      WHERE workspace_id=$1 AND employee_key='executive-orchestrator'`, [a.workspaceId])).rows[0]!.id;
    const employeeB = (await db.query<{ id: string }>(`SELECT id FROM digital_employees
      WHERE workspace_id=$1 AND employee_key='executive-orchestrator'`, [b.workspaceId])).rows[0]!.id;
    const first = (await officeRepo.createOfficeWorkItem({ workspaceId:a.workspaceId, employeeId:employeeA,
      idempotencyKey:`office-a-${crypto.randomUUID()}`, title:'First', sourceType:'workflow' })).item;
    const second = (await officeRepo.createOfficeWorkItem({ workspaceId:a.workspaceId, employeeId:employeeA,
      idempotencyKey:`office-a-${crypto.randomUUID()}`, title:'Second', sourceType:'workflow' })).item;
    const other = (await officeRepo.createOfficeWorkItem({ workspaceId:b.workspaceId, employeeId:employeeB,
      idempotencyKey:`office-b-${crypto.randomUUID()}`, title:'Other', sourceType:'workflow' })).item;
    await officeRepo.addWorkItemDependency({ workspaceId:a.workspaceId, workItemId:second.id, dependsOnWorkItemId:first.id });
    await assert.rejects(() => officeRepo.addWorkItemDependency({
      workspaceId:a.workspaceId, workItemId:first.id, dependsOnWorkItemId:second.id,
    }), { code:'23514' });
    await assert.rejects(() => officeRepo.addWorkItemDependency({
      workspaceId:a.workspaceId, workItemId:first.id, dependsOnWorkItemId:other.id,
    }), { code:'23503' });
  });

  it('applies controls idempotently with optimistic version checks and an audit trail', async () => {
    const f = await fixture();
    const employeeId = (await db.query<{ id: string }>(`SELECT id FROM digital_employees
      WHERE workspace_id=$1 AND employee_key='executive-orchestrator'`, [f.workspaceId])).rows[0]!.id;
    const created = await officeRepo.createOfficeWorkItem({ workspaceId:f.workspaceId, employeeId,
      idempotencyKey:`manual-${crypto.randomUUID()}`, title:'Operator-controlled work', sourceType:'manual', createdBy:f.owner });
    const pauseKey = `pause-${crypto.randomUUID()}`;
    const paused = await officeRepo.controlWorkItem({ workspaceId:f.workspaceId,workItemId:created.item.id,
      action:'pause',actorId:f.owner,expectedVersion:created.item.version,idempotencyKey:pauseKey,reason:'Review context' });
    assert.equal(paused.item.status, 'paused');
    assert.equal(paused.idempotent, false);
    const replay = await officeRepo.controlWorkItem({ workspaceId:f.workspaceId,workItemId:created.item.id,
      action:'pause',actorId:f.owner,expectedVersion:created.item.version,idempotencyKey:pauseKey,reason:'Review context' });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.item.status, 'paused');
    await assert.rejects(() => officeRepo.controlWorkItem({ workspaceId:f.workspaceId,workItemId:created.item.id,
      action:'resume',actorId:f.owner,expectedVersion:created.item.version,idempotencyKey:`resume-${crypto.randomUUID()}` }),
    (error: unknown) => (error as { code?: string }).code === 'OFFICE_WORK_ITEM_VERSION_CONFLICT');
    const audit = await db.query<{ action: string }>(`SELECT action FROM audit_log
      WHERE workspace_id=$1 AND entity_type='office_work_item' AND entity_id=$2`, [f.workspaceId,created.item.id]);
    assert.deepEqual(audit.rows.map((row) => row.action), ['office.work_item.pause']);
  });

  it('pauses and resumes a real agent run without recording a fake cancellation', async () => {
    const f = await fixture();
    const runId = await createRun(f.workspaceId,f.owner);
    const initial = (await db.query<{ id: string }>(`SELECT id FROM office_work_items
      WHERE workspace_id=$1 AND source_type='agent_run' AND source_agent_run_id=$2`,
    [f.workspaceId,runId])).rows[0]!;
    const beforePause = await officeRepo.findWorkItem(f.workspaceId,initial.id);
    assert.ok(beforePause?.availableControls?.includes('pause'));

    const paused = await officeRepo.controlWorkItem({
      workspaceId:f.workspaceId,workItemId:initial.id,action:'pause',actorId:f.owner,
      expectedVersion:beforePause!.version,idempotencyKey:`agent-pause-${crypto.randomUUID()}`,
    });
    assert.equal(paused.item.status,'paused');
    assert.equal(paused.item.errorCode,null);
    assert.equal(paused.item.errorMessage,null);
    const pausedRun = (await db.query<{ status: string; errorCode: string | null }>(`SELECT status,error_code AS "errorCode"
      FROM agent_runs WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,runId])).rows[0]!;
    assert.deepEqual(pausedRun,{status:'cancelled',errorCode:'OFFICE_PAUSED'});

    const visibleEvents = await db.query<{ eventType: string }>(`SELECT event_type AS "eventType"
      FROM office_work_item_events WHERE workspace_id=$1 AND work_item_id=$2 ORDER BY sequence`,
    [f.workspaceId,initial.id]);
    assert.ok(visibleEvents.rows.some((event) => event.eventType === 'office.work_item.paused'));
    assert.ok(!visibleEvents.rows.some((event) => event.eventType === 'office.work_item.cancelled'));
    const cancellationEvents = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM domain_events
      WHERE workspace_id=$1 AND aggregate_type='agent_run' AND aggregate_id=$2 AND event_type='run.cancelled'`,
    [f.workspaceId,runId]);
    assert.equal(Number(cancellationEvents.rows[0]!.count),0);

    const resumed = await officeRepo.controlWorkItem({
      workspaceId:f.workspaceId,workItemId:initial.id,action:'resume',actorId:f.owner,
      expectedVersion:paused.item.version,idempotencyKey:`agent-resume-${crypto.randomUUID()}`,
    });
    assert.equal(resumed.item.status,'queued');
    assert.equal(resumed.item.errorCode,null);
    const resumedRun = (await db.query<{ status: string; errorCode: string | null }>(`SELECT status,error_code AS "errorCode"
      FROM agent_runs WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,runId])).rows[0]!;
    assert.deepEqual(resumedRun,{status:'queued',errorCode:null});
  });

  it('never advertises or applies an unsafe Office cancel while an agent worker owns the lease', async () => {
    const f = await fixture();
    const runId = await createRun(f.workspaceId,f.owner,'sales','running');
    await db.query(`UPDATE agent_runs SET worker_id='office-test-worker',locked_at=NOW(),heartbeat_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId,runId]);
    const item = (await db.query<{ id: string; employeeId: string }>(`SELECT id,primary_employee_id AS "employeeId"
      FROM office_work_items WHERE workspace_id=$1 AND source_agent_run_id=$2`, [f.workspaceId,runId])).rows[0]!;
    const listed = await officeRepo.listEmployeeWork({
      workspaceId:f.workspaceId,employeeId:item.employeeId,limit:10,offset:0,
    });
    const active = listed.items.find((candidate) => candidate.id === item.id)!;
    assert.equal(active.sourceWorkerId,'office-test-worker');
    assert.ok(!active.availableControls?.includes('cancel'));
    await assert.rejects(() => officeRepo.controlWorkItem({
      workspaceId:f.workspaceId,workItemId:item.id,action:'cancel',actorId:f.owner,
      expectedVersion:active.version,idempotencyKey:`unsafe-cancel-${crypto.randomUUID()}`,
    }), (error: unknown) => (error as { code?: string }).code === 'OFFICE_CONTROL_NOT_AVAILABLE');
    const lease = (await db.query<{ workerId: string | null; status: string }>(`SELECT worker_id AS "workerId",status
      FROM agent_runs WHERE workspace_id=$1 AND id=$2`, [f.workspaceId,runId])).rows[0]!;
    assert.deepEqual(lease,{workerId:'office-test-worker',status:'running'});
  });

  it('keeps a cooperatively cancelled run cancelled when its worker reports a late success', async () => {
    const f = await fixture();
    const runId = await createRun(f.workspaceId,f.owner,'sales','running');
    await db.query(`UPDATE agent_runs SET worker_id='late-worker',locked_at=NOW(),heartbeat_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId,runId]);
    const cancelled = await agentService.cancelRun(f.workspaceId,runId,f.owner);
    assert.equal(cancelled?.status,'cancelled');
    assert.equal(cancelled?.workerId,'late-worker');
    const stalePlanningUpdate = await agentRepo.updateRun(runId,{status:'running'});
    assert.equal(stalePlanningUpdate,undefined);
    const late = await agentRepo.finalizeRun({
      workspaceId:f.workspaceId,runId,status:'completed',patch:{result:{reported:'late'},finished_at:new Date()},
      eventPayload:{reported:'late'},actorId:f.owner,
    });
    assert.equal(late.status,'cancelled');
    const persisted = await agentRepo.getRun(f.workspaceId,runId);
    assert.equal(persisted?.status,'cancelled');
    assert.equal(persisted?.result,null);
    const events = await db.query<{ eventType: string }>(`SELECT event_type AS "eventType" FROM domain_events
      WHERE workspace_id=$1 AND aggregate_type='agent_run' AND aggregate_id=$2
        AND event_type IN ('run.cancelled','run.completed') ORDER BY occurred_at`, [f.workspaceId,runId]);
    assert.deepEqual(events.rows.map((event) => event.eventType),['run.cancelled']);
  });

  it('returns no work controls to members without agents.manage while preserving the authoritative route guard', async () => {
    const f = await fixture();
    const viewer = await addWorkspaceMember(f.workspaceId,'viewer');
    const employeeId = (await db.query<{ id: string }>(`SELECT id FROM digital_employees
      WHERE workspace_id=$1 AND employee_key='executive-orchestrator'`, [f.workspaceId])).rows[0]!.id;
    const created = await officeRepo.createOfficeWorkItem({workspaceId:f.workspaceId,employeeId,
      idempotencyKey:`permission-${crypto.randomUUID()}`,title:'Permission-scoped work',sourceType:'manual',createdBy:f.owner});
    const app = createApp();
    const viewerWork = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/employees/${employeeId}/work`)
      .set('Authorization',`Bearer ${viewer.token}`);
    assert.equal(viewerWork.status,200);
    assert.equal(viewerWork.body.data.canControl,false);
    assert.deepEqual(viewerWork.body.data.items[0].availableControls,[]);
    const ownerWork = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/employees/${employeeId}/work`)
      .set('Authorization',`Bearer ${f.token}`);
    assert.equal(ownerWork.status,200);
    assert.equal(ownerWork.body.data.canControl,true);
    assert.ok(ownerWork.body.data.items[0].availableControls.length > 0);
    const forbidden = await request(app)
      .post(`/api/v1/workspaces/${f.workspaceId}/office/work-items/${created.item.id}/pause`)
      .set('Authorization',`Bearer ${viewer.token}`)
      .send({expectedVersion:created.item.version,idempotencyKey:`viewer-pause-${crypto.randomUUID()}`});
    assert.equal(forbidden.status,403);
  });

  it('never exposes finance employees, invoice work, or invoice payloads to marketing roles', async () => {
    const f = await fixture();
    const marketer = await addWorkspaceMember(f.workspaceId, 'marketing_manager');
    await officeRepo.ensureOfficeRoster(f.workspaceId);
    const employees = await db.query<{ id: string; key: string }>(
      `SELECT id,employee_key AS key FROM digital_employees
       WHERE workspace_id=$1 AND employee_key IN ('brand-content-strategist','invoice-manager')`,
      [f.workspaceId],
    );
    const brandEmployee = employees.rows.find((row) => row.key === 'brand-content-strategist')!;
    const invoiceEmployee = employees.rows.find((row) => row.key === 'invoice-manager')!;
    const secretInvoiceId = crypto.randomUUID();
    const invoiceWork = await officeRepo.createOfficeWorkItem({
      workspaceId: f.workspaceId,
      employeeId: brandEmployee.id,
      idempotencyKey: `misassigned-invoice-${crypto.randomUUID()}`,
      title: 'Confidential invoice collection',
      sourceType: 'domain_event',
      relatedObjectType: 'invoice',
      relatedObjectId: secretInvoiceId,
      context: { amountMinor: 987654, bankReference: 'PRIVATE-REFERENCE' },
    });
    await db.query(
      `INSERT INTO domain_events(workspace_id,event_type,aggregate_type,aggregate_id,payload,metadata)
       VALUES($1,'invoice.paid','invoice',$2,$3::jsonb,'{}'::jsonb)`,
      [f.workspaceId, secretInvoiceId, JSON.stringify({ invoiceId: secretInvoiceId, amountMinor: 987654, currency: 'CNY', paymentMethod: 'private-bank', status: 'PAID' })],
    );
    const app = createApp();
    const overview = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/overview?timelineLimit=100`)
      .set('Authorization', `Bearer ${marketer.token}`);
    assert.equal(overview.status, 200);
    const visibleKeys = overview.body.data.departments.flatMap((department: { employees: Array<{ key: string }> }) => department.employees.map((employee) => employee.key));
    assert.ok(!visibleKeys.includes('invoice-manager'));
    assert.ok(!visibleKeys.includes('billing-usage-manager'));
    assert.ok(!visibleKeys.includes('bookkeeping-manager'));
    assert.ok(!JSON.stringify(overview.body.data).includes(secretInvoiceId));
    assert.ok(!JSON.stringify(overview.body.data).includes('987654'));

    const timeline = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/timeline?limit=100`)
      .set('Authorization', `Bearer ${marketer.token}`);
    assert.equal(timeline.status, 200);
    assert.ok(!timeline.body.data.items.some((item: { aggregateType: string | null }) => item.aggregateType === 'invoice'));
    assert.ok(!JSON.stringify(timeline.body.data).includes(secretInvoiceId));

    const employeeDetail = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/employees/${brandEmployee.id}`)
      .set('Authorization', `Bearer ${marketer.token}`);
    assert.equal(employeeDetail.status, 200);
    assert.ok(!employeeDetail.body.data.recentTimeline.some((item: { workItemId: string | null }) => item.workItemId === invoiceWork.item.id));
    assert.equal(employeeDetail.body.data.currentWorkItem, null);
    const hiddenFinanceEmployee = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/employees/${invoiceEmployee.id}`)
      .set('Authorization', `Bearer ${marketer.token}`);
    assert.equal(hiddenFinanceEmployee.status, 404);

    const ownerTimeline = await request(app)
      .get(`/api/v1/workspaces/${f.workspaceId}/office/timeline?limit=100`)
      .set('Authorization', `Bearer ${f.token}`);
    const invoiceEvent = ownerTimeline.body.data.items.find((item: { aggregateId: string | null }) => item.aggregateId === secretInvoiceId);
    assert.ok(invoiceEvent);
    assert.deepEqual(invoiceEvent.payload, { status: 'PAID' });
  });

  it('exposes authenticated Office APIs and protects them from anonymous access', async () => {
    const f = await fixture();
    const anonymous = await request(createApp()).get(`/api/v1/workspaces/${f.workspaceId}/office/overview`);
    assert.equal(anonymous.status, 401);
    const overview = await request(createApp())
      .get(`/api/v1/workspaces/${f.workspaceId}/office/overview`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.success, true);
    assert.equal(overview.body.data.summary.employeeCount, 29);
    const employeeId = overview.body.data.departments[0].employees[0].id;
    const detail = await request(createApp())
      .get(`/api/v1/workspaces/${f.workspaceId}/office/employees/${employeeId}`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.data.capabilities));
  });

  it('allows a complete tenant teardown without leaving Office rows behind', async () => {
    const f = await fixture();
    const employeeId = (await db.query<{ id: string }>(`SELECT id FROM digital_employees
      WHERE workspace_id=$1 LIMIT 1`, [f.workspaceId])).rows[0]!.id;
    await officeRepo.createOfficeWorkItem({ workspaceId:f.workspaceId,employeeId,
      idempotencyKey:`teardown-${crypto.randomUUID()}`,title:'Disposable work',sourceType:'system' });
    await db.query(`DELETE FROM workspaces WHERE id=$1`, [f.workspaceId]);
    const remaining = await db.query<{ total: number }>(`SELECT count(*)::int AS total
      FROM office_work_item_events WHERE workspace_id=$1`, [f.workspaceId]);
    assert.equal(remaining.rows[0]!.total, 0);
  });
});
