import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/executive_ops_tests_only';
process.env.JWT_SECRET = 'executive-ops-tests-only-not-a-production-key';

const { pool } = await import('../src/db/pool.js');
const executive = await import('../src/modules/executive-ops/executive-ops.service.js');
const executiveRepo = await import('../src/modules/executive-ops/executive-ops.repo.js');
const { WORKSPACE_CAPABILITIES } = await import('../src/modules/workspaces/workspace-permissions.js');
const db = new PGlite();

const fullAccess = { capabilities: new Set(WORKSPACE_CAPABILITIES) };
const agentOnlyAccess = { capabilities: new Set(['agents.read'] as const) };

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

async function fixture() {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@example.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES('Executive test',$1) RETURNING id`,
    [userId],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId]);
  return { userId, workspaceId };
}

test('creates evidence-backed executive cycles, forecasts, scenarios, approved plan work, and forecast learning', async () => {
  const { userId, workspaceId } = await fixture();
  const metricId = (await db.query<{ id: string }>(
    `INSERT INTO metric_definitions(workspace_id,key,name,domain,unit,source)
     VALUES($1,'qualified_pipeline','Qualified pipeline','growth','EUR','test') RETURNING id`,
    [workspaceId],
  )).rows[0]!.id;
  const firstMeasuredAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const latestMeasuredAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await db.query(
    `INSERT INTO metric_points(metric_id,recorded_at,value,dimensions)
     VALUES($1,$2,100,'{}'::jsonb),($1,$3,120,'{}'::jsonb)`,
    [metricId, firstMeasuredAt, latestMeasuredAt],
  );

  await db.query(
    `INSERT INTO invoices(workspace_id,invoice_number,currency,status,due_date,amount_due)
     VALUES($1,'EXEC-OVERDUE-001','EUR','OVERDUE',CURRENT_DATE - 5,1250.50)`,
    [workspaceId],
  );
  const observationId = (await db.query<{ id: string }>(
    `INSERT INTO company_brain_observations(workspace_id,source_type,source_key,subject_type,summary)
     VALUES($1,'user','executive-signal-test','test','A material verified signal requires review.') RETURNING id`,
    [workspaceId],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO company_brain_signals(workspace_id,observation_id,signal_type,severity,materiality,explanation)
     VALUES($1,$2,'provider_change',4,0.8,'A verified provider change has material operational impact.')`,
    [workspaceId, observationId],
  );
  const missionId = (await db.query<{ id: string }>(
    `INSERT INTO company_brain_missions(workspace_id,title,objective,priority)
     VALUES($1,'Recover the blocked operation','Verify the blocker.',90) RETURNING id`,
    [workspaceId],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO company_brain_tasks(workspace_id,mission_id,task_type,title,status,priority,blocked_reason)
     VALUES($1,$2,'integration-recovery','Recover provider configuration','BLOCKED',90,'PROVIDER_EVIDENCE_REQUIRED')`,
    [workspaceId, missionId],
  );
  await db.query(
    `INSERT INTO agent_runs(workspace_id,created_by,goal,status,plan,error_code)
     VALUES($1,$2,'Executive test run','failed','{"module":"crm"}'::jsonb,'PROVIDER_UNAVAILABLE')`,
    [workspaceId, userId],
  );

  const schedules = await executiveRepo.ensureDefaultSchedules(workspaceId);
  assert.equal(schedules.length, 2);
  const claimedSchedules = await executiveRepo.claimDueSchedules('executive-test-worker', 120, 2, [workspaceId]);
  assert.equal(claimedSchedules.length, 2);
  for (const schedule of claimedSchedules) {
    const completedSchedule = await executiveRepo.completeScheduleRun({
      workspaceId,
      cycleType: schedule.cycleType,
      workerId: 'executive-test-worker',
    });
    assert.ok(completedSchedule?.nextRunAt);
  }

  const first = await executive.runCycle({
    workspaceId,
    cycleType: 'daily',
    triggerType: 'manual',
    startedBy: userId,
    access: fullAccess,
  });
  assert.equal(first.cycle.status, 'completed');
  assert.ok(first.findings.some((finding) => finding.findingType === 'financial_risk'));
  assert.ok(first.findings.some((finding) => finding.findingType === 'operational_bottleneck'));
  assert.ok(first.findings.some((finding) => finding.findingType === 'agent_failure'));
  assert.equal(first.forecasts.length, 1);
  assert.equal(Number(first.forecasts[0]!.projectedBase), 140);
  assert.ok(first.proposals.some((proposal) => proposal.proposalType === 'finance'));
  assert.ok(first.proposals.every((proposal) => proposal.executionMode === 'plan_only' && proposal.requiresHumanApproval));

  const replay = await executive.runCycle({
    workspaceId,
    cycleType: 'daily',
    triggerType: 'manual',
    startedBy: userId,
    access: fullAccess,
  });
  assert.equal(replay.cycle.id, first.cycle.id);
  assert.equal(replay.findings.length, first.findings.length);
  assert.equal(replay.forecasts.length, first.forecasts.length);

  const hiddenFinance = await executive.getCycleDetail(workspaceId, first.cycle.id, agentOnlyAccess);
  assert.ok(hiddenFinance.findings.every((finding) => finding.findingType !== 'financial_risk'));
  assert.equal(hiddenFinance.cycle.summary.financialRiskCount, undefined);
  assert.equal(hiddenFinance.cycle.evidence.finance, undefined);

  const scenario = await executive.createScenario({
    workspaceId,
    cycleId: first.cycle.id,
    name: 'Ten percent upside',
    description: 'Explicit sensitivity case.',
    assumptions: ['Qualified pipeline converts ten percent above the transparent base projection.'],
    projections: [{ forecastId: first.forecasts[0]!.id, adjustmentPercent: 10 }],
    createdBy: userId,
  });
  assert.equal(scenario.status, 'ready');
  assert.equal(Number(scenario.projections?.[0]?.projectedValue), 154);
  assert.equal(scenario.projections?.[0]?.evidence.method, 'explicit_percentage_adjustment');

  const financeProposal = first.proposals.find((proposal) => proposal.proposalType === 'finance');
  assert.ok(financeProposal);
  const dispatched = await executive.decideProposal({
    workspaceId,
    proposalId: financeProposal!.id,
    expectedVersion: financeProposal!.version,
    decision: 'approve',
    actorId: userId,
  });
  assert.equal(dispatched.status, 'dispatched');
  assert.ok(dispatched.companyBrainMissionId);
  const proposalDetail = await executive.getProposal(workspaceId, financeProposal!.id, fullAccess);
  assert.ok(proposalDetail.events.some((event) => event.eventType === 'APPROVED'));
  assert.ok(proposalDetail.events.some((event) => event.eventType === 'DISPATCHED'));

  await db.query(
    `INSERT INTO metric_points(metric_id,recorded_at,value,dimensions)
     VALUES($1,$2,150,'{}'::jsonb)`,
    [metricId, new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()],
  );
  const calibrated = await executive.calibrateDueForecasts(workspaceId, 10);
  assert.equal(calibrated.length, 1);
  assert.equal(calibrated[0]?.status, 'calibrated');
  assert.equal(Number(calibrated[0]?.actualValue), 150);
  const overview = await executive.getOverview(workspaceId, fullAccess);
  assert.ok(overview.learning.some((record) => record.learningType === 'forecast_calibration' && record.verified));
});

test('rejects cross-workspace forecast references in a scenario', async () => {
  const source = await fixture();
  const foreign = await fixture();
  const metricId = (await db.query<{ id: string }>(
    `INSERT INTO metric_definitions(workspace_id,key,name,domain,unit)
     VALUES($1,'cross_tenant_metric','Cross tenant metric','growth','number') RETURNING id`,
    [source.workspaceId],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO metric_points(metric_id,recorded_at,value,dimensions)
     VALUES($1,$2,10,'{}'::jsonb),($1,$3,12,'{}'::jsonb)`,
    [metricId, new Date(Date.now() - 3 * 86_400_000).toISOString(), new Date(Date.now() - 2 * 86_400_000).toISOString()],
  );
  const sourceCycle = await executive.runCycle({
    workspaceId: source.workspaceId,
    cycleType: 'daily',
    triggerType: 'manual',
    startedBy: source.userId,
    access: fullAccess,
  });
  const foreignCycle = await executive.runCycle({
    workspaceId: foreign.workspaceId,
    cycleType: 'daily',
    triggerType: 'manual',
    startedBy: foreign.userId,
    access: fullAccess,
  });
  await assert.rejects(
    () => executive.createScenario({
      workspaceId: foreign.workspaceId,
      cycleId: foreignCycle.cycle.id,
      name: 'Invalid cross tenant scenario',
      description: '',
      assumptions: [],
      projections: [{ forecastId: sourceCycle.forecasts[0]!.id, adjustmentPercent: 5 }],
      createdBy: foreign.userId,
    }),
    /outside this workspace/i,
  );
});

test('rejects a manually linked finding from another workspace before inserting a proposal', async () => {
  const source = await fixture();
  const foreign = await fixture();
  const sourceCycle = await executive.runCycle({
    workspaceId: source.workspaceId,
    cycleType: 'daily',
    triggerType: 'manual',
    startedBy: source.userId,
    access: fullAccess,
  });
  const finding = await executiveRepo.upsertFindings([{
    workspaceId: source.workspaceId,
    cycleId: sourceCycle.cycle.id,
    sourceKey: 'cross-workspace-finding',
    findingType: 'operational_bottleneck',
    subjectType: 'test',
    severity: 2,
    materiality: 0.2,
    title: 'Source workspace finding',
    description: 'This finding belongs only to the source workspace.',
    evidence: {},
  }]);
  await assert.rejects(
    () => executive.createProposal({
      workspaceId: foreign.workspaceId,
      proposalType: 'operations',
      title: 'Invalid foreign finding link',
      objective: 'This must not be created.',
      priority: 50,
      confidence: 0.5,
      expectedImpact: {},
      riskNotes: [],
      evidence: {},
      findingId: finding[0]!.id,
      createdBy: foreign.userId,
    }),
    /Executive finding not found/i,
  );
  assert.equal((await executive.listProposals(foreign.workspaceId, 10, fullAccess)).length, 0);
});

test('creates measured product and campaign recovery proposals with deterministic Digital Employee plan teams', async () => {
  const { userId, workspaceId } = await fixture();
  const productMetricId = (await db.query<{ id: string }>(
    `INSERT INTO metric_definitions(workspace_id,key,name,domain,unit)
     VALUES($1,'product_activation','Product activation','product','percent') RETURNING id`,
    [workspaceId],
  )).rows[0]!.id;
  const campaignMetricId = (await db.query<{ id: string }>(
    `INSERT INTO metric_definitions(workspace_id,key,name,domain,unit)
     VALUES($1,'campaign_conversion','Campaign conversion','marketing','percent') RETURNING id`,
    [workspaceId],
  )).rows[0]!.id;
  const older = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const latest = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await db.query(
    `INSERT INTO metric_points(metric_id,recorded_at,value,dimensions)
     VALUES($1,$3,80,'{}'::jsonb),($1,$4,36,'{}'::jsonb),($2,$3,50,'{}'::jsonb),($2,$4,20,'{}'::jsonb)`,
    [productMetricId, campaignMetricId, older, latest],
  );

  const cycle = await executive.runCycle({
    workspaceId,
    cycleType: 'weekly',
    triggerType: 'manual',
    startedBy: userId,
    access: fullAccess,
  });
  const productFinding = cycle.findings.find((finding) => finding.findingType === 'product_risk');
  const campaignFinding = cycle.findings.find((finding) => finding.findingType === 'campaign_risk');
  assert.ok(productFinding);
  assert.ok(campaignFinding);
  assert.match(productFinding!.description, /80.*36/);
  assert.match(campaignFinding!.description, /50.*20/);

  const productProposal = cycle.proposals.find((proposal) => proposal.proposalType === 'product');
  const campaignProposal = cycle.proposals.find((proposal) => proposal.proposalType === 'campaign');
  assert.ok(productProposal);
  assert.ok(campaignProposal);
  assert.equal(productProposal!.executionMode, 'plan_only');
  assert.equal(campaignProposal!.executionMode, 'plan_only');

  const dispatchedProduct = await executive.decideProposal({
    workspaceId,
    proposalId: productProposal!.id,
    expectedVersion: productProposal!.version,
    decision: 'approve',
    actorId: userId,
  });
  const dispatchedCampaign = await executive.decideProposal({
    workspaceId,
    proposalId: campaignProposal!.id,
    expectedVersion: campaignProposal!.version,
    decision: 'approve',
    actorId: userId,
  });
  assert.equal(dispatchedProduct.status, 'dispatched');
  assert.equal(dispatchedCampaign.status, 'dispatched');

  const teamForMission = async (missionId: string) => (await db.query<{ employeeKey: string; taskType: string; status: string }>(
    `SELECT employee.employee_key AS "employeeKey",task.task_type AS "taskType",task.status
       FROM company_brain_tasks task
       JOIN digital_employees employee ON employee.workspace_id=task.workspace_id AND employee.id=task.assigned_employee_id
      WHERE task.workspace_id=$1 AND task.mission_id=$2
      ORDER BY employee.employee_key ASC`,
    [workspaceId, missionId],
  )).rows;
  const productTeam = await teamForMission(dispatchedProduct.companyBrainMissionId!);
  const campaignTeam = await teamForMission(dispatchedCampaign.companyBrainMissionId!);
  assert.deepEqual(productTeam.map((task) => task.employeeKey), [
    'commerce-analytics-manager', 'outcome-quality-auditor', 'product-manager',
  ]);
  assert.deepEqual(campaignTeam.map((task) => task.employeeKey), [
    'marketing-manager', 'outcome-quality-auditor', 'paid-acquisition-specialist', 'security-policy-auditor',
  ]);
  assert.ok([...productTeam, ...campaignTeam].every((task) => task.status === 'PROPOSED'));

  await assert.rejects(
    () => executive.verifyProposalOutcome({
      workspaceId,
      proposalId: dispatchedProduct.id,
      expectedVersion: dispatchedProduct.version,
      outcome: 'Product plan has not completed yet.',
      evidence: { metricId: productMetricId },
      confidence: 0.5,
      idempotencyKey: 'executive-product-outcome-before-completion',
      actorId: userId,
    }),
    /mission is completed/i,
  );
  await db.query(`UPDATE company_brain_tasks SET status='COMPLETED',result='{"verified":true}'::jsonb
    WHERE workspace_id=$1 AND mission_id=$2`, [workspaceId, dispatchedProduct.companyBrainMissionId]);
  await db.query(`UPDATE company_brain_missions SET status='COMPLETED'
    WHERE workspace_id=$1 AND id=$2`, [workspaceId, dispatchedProduct.companyBrainMissionId]);
  const outcome = await executive.verifyProposalOutcome({
    workspaceId,
    proposalId: dispatchedProduct.id,
    expectedVersion: dispatchedProduct.version,
    outcome: 'The plan evidence was verified after the delegated product reviews completed.',
    evidence: { metricId: productMetricId, measuredPoint: '36', planOnly: true },
    confidence: 0.85,
    idempotencyKey: 'executive-product-outcome-completed',
    actorId: userId,
  });
  assert.equal(outcome.proposal.status, 'completed');
  assert.equal(outcome.learning?.learningType, 'proposal_outcome_review');
  assert.equal(outcome.learning?.verified, true);
  const outcomeReplay = await executive.verifyProposalOutcome({
    workspaceId,
    proposalId: dispatchedProduct.id,
    expectedVersion: dispatchedProduct.version,
    outcome: 'The plan evidence was verified after the delegated product reviews completed.',
    evidence: { metricId: productMetricId, measuredPoint: '36', planOnly: true },
    confidence: 0.85,
    idempotencyKey: 'executive-product-outcome-completed',
    actorId: userId,
  });
  assert.equal(outcomeReplay.replayed, true);
  assert.equal(outcomeReplay.learning?.id, outcome.learning?.id);
});

test('creates CRM recovery plans from overdue follow-ups and stalled canonical opportunities without exposing them to non-CRM readers', async () => {
  const { userId, workspaceId } = await fixture();
  await db.query(`INSERT INTO resource_types(key,domain,label,description) VALUES
    ('crm_tasks','crm','CRM Tasks','CRM-related tasks.'),
    ('sales_opportunities','sales','Sales Opportunities','Qualified sales opportunities.')
    ON CONFLICT (key) DO NOTHING`);
  const overdueAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const staleUpdatedAt = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const overdueTaskId = (await db.query<{ id: string }>(
    `INSERT INTO workspace_records(workspace_id,resource_type,name,status,stage,due_at,created_by)
     VALUES($1,'crm_tasks','Follow up with verified customer','active','open',$3,$2) RETURNING id`,
    [workspaceId, userId, overdueAt],
  )).rows[0]!.id;
  const stalledOpportunityId = (await db.query<{ id: string }>(
    `INSERT INTO workspace_records(workspace_id,resource_type,name,status,stage,data,created_by,created_at,updated_at)
     VALUES($1,'sales_opportunities','Enterprise expansion','active','negotiation','{"pipeline":{"state":"negotiation"}}'::jsonb,$2,$3,$3)
     RETURNING id`,
    [workspaceId, userId, staleUpdatedAt],
  )).rows[0]!.id;
  const directRisks = await executiveRepo.listCrmPipelineRisks(workspaceId, 24, new Date().toISOString());
  assert.equal(directRisks.length, 2, JSON.stringify(directRisks));

  const cycle = await executive.runCycle({
    workspaceId,
    cycleType: 'daily',
    triggerType: 'manual',
    startedBy: userId,
    access: fullAccess,
  });
  const crmFindings = cycle.findings.filter((finding) => finding.findingType === 'crm_risk');
  assert.equal(crmFindings.length, 2, JSON.stringify(cycle.findings));
  assert.ok(crmFindings.some((finding) => finding.subjectId === overdueTaskId && /Overdue CRM follow-up/.test(finding.title)));
  assert.ok(crmFindings.some((finding) => finding.subjectId === stalledOpportunityId && /Stalled CRM opportunity/.test(finding.title)));
  assert.equal(cycle.cycle.summary.crmRiskCount, 2);
  assert.deepEqual(cycle.cycle.evidence.crm, { overdueFollowUps: 1, stalledOpportunities: 1 });

  const hiddenForAgentOnly = await executive.getCycleDetail(workspaceId, cycle.cycle.id, agentOnlyAccess);
  assert.ok(hiddenForAgentOnly.findings.every((finding) => finding.findingType !== 'crm_risk'));
  assert.equal(hiddenForAgentOnly.cycle.summary.crmRiskCount, undefined);
  assert.equal(hiddenForAgentOnly.cycle.evidence.crm, undefined);

  const proposal = cycle.proposals.find((item) => item.proposalType === 'crm');
  assert.ok(proposal);
  const dispatched = await executive.decideProposal({
    workspaceId,
    proposalId: proposal!.id,
    expectedVersion: proposal!.version,
    decision: 'approve',
    actorId: userId,
  });
  assert.equal(dispatched.status, 'dispatched');
  const team = (await db.query<{ employeeKey: string; taskType: string; objective: string }>(
    `SELECT employee.employee_key AS "employeeKey",task.task_type AS "taskType",task.objective
       FROM company_brain_tasks task
       JOIN digital_employees employee ON employee.workspace_id=task.workspace_id AND employee.id=task.assigned_employee_id
      WHERE task.workspace_id=$1 AND task.mission_id=$2
      ORDER BY employee.employee_key ASC`,
    [workspaceId, dispatched.companyBrainMissionId],
  )).rows;
  assert.deepEqual(team.map((task) => task.employeeKey), [
    'crm-manager', 'customer-manager', 'outcome-quality-auditor',
  ]);
  assert.ok(team.some((task) => /Do not change CRM records|Do not contact a customer/i.test(task.objective)));
});
