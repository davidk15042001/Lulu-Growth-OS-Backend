import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/part2_tests_only';
process.env.JWT_SECRET = 'part2-tests-only-not-a-production-key';
const { pool } = await import('../src/db/pool.js');
const authorization = await import('../src/modules/workspaces/workspace-authorization.service.js');
const entitlements = await import('../src/modules/entitlements/entitlement.service.js');
const identity = await import('../src/modules/business-identity/identity.service.js');
const workspaceRepo = await import('../src/modules/workspaces/workspace.repo.js');
const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  await db.query(`INSERT INTO users(id,email,password_hash,role,verified_at) VALUES($1,'part2@example.test','hash','user',NOW())`, [crypto.randomUUID()]);
  const execute = async (sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
});

after(async () => { mock.restoreAll(); await pool.end(); await db.close(); });

async function fixture() {
  const owner = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  const member = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  const a = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Workspace A',$1) RETURNING id`, [owner])).rows[0]!.id;
  const b = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Workspace B',$1) RETURNING id`, [owner])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')`, [a, owner, member]);
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [b, owner]);
  await db.query(`INSERT INTO workspace_subscriptions(workspace_id,plan_key,status) VALUES($1,'ai','active'),($2,'starter','active')`, [a, b]);
  return { owner, member, a, b };
}

describe('Part 2 tenant and authorization foundation', () => {
  it('denies cross-workspace access and resolves capabilities from roles', async () => {
    const f = await fixture();
    assert.equal((await authorization.authorizeWorkspaceAction({ workspaceId: f.a, userId: f.owner, capability: 'workspace.manage' })).allowed, true);
    assert.equal((await authorization.authorizeWorkspaceAction({ workspaceId: f.a, userId: f.member, capability: 'products.update' })).allowed, false);
    assert.equal((await authorization.authorizeWorkspaceAction({ workspaceId: f.b, userId: f.member, capability: 'workspace.read' })).allowed, false);
  });

  it('prevents a sole owner from being removed', async () => {
    const f = await fixture();
    await assert.rejects(() => db.query(`DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [f.a, f.owner]), { code: '23514' });
  });

  it('prevents a sole owner from being demoted', async () => {
    const f = await fixture();
    await assert.rejects(() => db.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.a, f.owner]), { code: '23514' });
  });

  it('prevents new record relationships from crossing workspace boundaries', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO resource_types(key,domain,label) VALUES('part2_record','crm','Part 2 record') ON CONFLICT DO NOTHING`);
    const aRecord = (await db.query<{ id: string }>(`INSERT INTO workspace_records(workspace_id,resource_type,name,created_by) VALUES($1,'part2_record','A',$2) RETURNING id`, [f.a, f.owner])).rows[0]!.id;
    const bRecord = (await db.query<{ id: string }>(`INSERT INTO workspace_records(workspace_id,resource_type,name,created_by) VALUES($1,'part2_record','B',$2) RETURNING id`, [f.b, f.owner])).rows[0]!.id;
    await assert.rejects(() => db.query(`INSERT INTO record_relationships(workspace_id,source_record_id,target_record_id,relationship_type,created_by) VALUES($1,$2,$3,'related',$4)`, [f.a, aRecord, bRecord, f.owner]), { code: '23503' });
  });

  it('resolves plan entitlements and applies a workspace override', async () => {
    const f = await fixture();
    assert.equal((await entitlements.resolveWorkspaceEntitlements(f.a))['ai.enabled'].enabled, true);
    await entitlements.addWorkspaceOverride({ workspaceId: f.a, entitlementKey: 'ai.enabled', enabled: false, reason: 'Temporary safety pause', actorId: f.owner });
    const effective = await entitlements.resolveWorkspaceEntitlements(f.a);
    assert.equal(effective['ai.enabled'].enabled, false);
    assert.equal(effective['ai.enabled'].source, 'override');
  });

  it('creates an idempotent organization, legal entity and factory mapping', async () => {
    const f = await fixture();
    const client = await pool.connect();
    const first = await identity.ensureWorkspaceBusinessIdentity({ workspaceId: f.a, name: 'Workspace A', country: 'CN', taxIdentifier: 'CN-1' }, client as never);
    const second = await identity.ensureWorkspaceBusinessIdentity({ workspaceId: f.a, name: 'Workspace A', country: 'CN', taxIdentifier: 'CN-1' }, client as never);
    assert.equal(first.organizationId, second.organizationId);
    assert.equal(first.factoryId, second.factoryId);
    const count = await db.query<{ total: string }>(`SELECT count(*)::text AS total FROM organizations WHERE source_workspace_id=$1`, [f.a]);
    assert.equal(count.rows[0]!.total, '1');
  });

  it('saves the complete company profile for an owner before billing is active', async () => {
    const f = await fixture();
    await db.query(`DELETE FROM workspace_subscriptions WHERE workspace_id=$1`, [f.a]);
    const saved = await workspaceRepo.updateWorkspaceProfile(f.a, f.owner, {
      companyName: 'Workspace A International',
      industry: 'Manufacturing',
      countryRegion: 'CN',
      taxId: 'CN-TAX-1',
      address: 'Shanghai',
      legalForm: 'Limited company',
      legalRepresentative: 'Owner',
      phoneNumber: '+86 21 0000 0000',
      bankAccountNumber: '123456789',
      bankOpeningBank: 'Example Bank',
      bankBranch: 'Shanghai Branch',
      bankCode: 'EXAMPLECN',
    });
    assert.equal(saved?.companyName, 'Workspace A International');
    assert.equal(saved?.bankCode, 'EXAMPLECN');
    const persisted = (await db.query<{ name: string; taxId: string; bankCode: string }>(
      `SELECT name, tax_id AS "taxId", bank_code AS "bankCode" FROM workspaces WHERE id=$1`, [f.a],
    )).rows[0];
    assert.deepEqual(persisted, { name: 'Workspace A International', taxId: 'CN-TAX-1', bankCode: 'EXAMPLECN' });
  });

  it('completes the profile gate with company name and industry only', async () => {
    const f = await fixture();
    await db.query(
      `UPDATE workspaces SET onboarding_step='profile_completion',profile_completed_at=NULL,
        country_region=NULL,tax_id=NULL,address=NULL,legal_form=NULL,legal_representative=NULL,
        phone_number=NULL,bank_account_number=NULL,bank_opening_bank=NULL,bank_branch=NULL,bank_code=NULL
       WHERE id=$1`,
      [f.a],
    );

    const saved = await workspaceRepo.updateWorkspaceProfile(f.a, f.owner, {
      companyName: 'Minimum Identity Company',
      industry: 'Software',
    });

    assert.equal(saved?.onboardingStep, 'knowledge_base');
    assert.ok(saved?.profileCompletedAt);
    assert.deepEqual(saved?.missingRequiredFields, []);
  });
});
