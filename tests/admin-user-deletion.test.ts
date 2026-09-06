import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/admin_user_deletion_tests_only';
process.env.JWT_SECRET = 'admin-user-deletion-tests-only-not-a-production-key';

const { pool } = await import('../src/db/pool.js');
const admin = await import('../src/modules/admin/admin.repo.js');
const adminUserDeletionWorker = await import('../src/modules/admin/admin-user-deletion.worker.js');
const { RESOURCE_CATALOG } = await import('../src/domain/resource-catalog.js');
const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  for (const resource of RESOURCE_CATALOG) {
    await db.query(
      'INSERT INTO resource_types(key, domain, label, description) VALUES($1, $2, $3, $4)',
      [resource.key, resource.domain, resource.label, resource.description],
    );
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

async function createUser(email: string, role: 'user' | 'admin' = 'user') {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO users(id, email, password_hash, role, verified_at)
     VALUES($1, $2, 'not-a-real-password-hash', $3, NOW())`,
    [id, email, role],
  );
  return id;
}

describe('admin user deletion', () => {
  it('physically deletes an account, its owned workspace, and its personal shared-workspace data', async () => {
    const target = await createUser(`delete-${crypto.randomUUID()}@example.test`, 'admin');
    const collaborator = await createUser(`keep-${crypto.randomUUID()}@example.test`);
    const ownedWorkspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Delete me', $1) RETURNING id`,
      [target],
    )).rows[0]!;
    const previouslyDeletedWorkspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by, deleted_at)
       VALUES('Previously deleted', $1, NOW()) RETURNING id`,
      [target],
    )).rows[0]!;
    const sharedWorkspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Keep me', $1) RETURNING id`,
      [collaborator],
    )).rows[0]!;
    await db.query(
      `INSERT INTO workspace_members(workspace_id, user_id, role)
       VALUES($1, $2, 'owner'), ($1, $3, 'member'), ($4, $2, 'member'), ($4, $3, 'owner')`,
      [ownedWorkspace.id, target, collaborator, sharedWorkspace.id],
    );

    const collaboratorRecord = (await db.query<{ id: string }>(
      `INSERT INTO workspace_records(workspace_id, resource_type, name, created_by)
       VALUES($1, 'crm_contacts', 'Collaborator record', $2) RETURNING id`,
      [sharedWorkspace.id, collaborator],
    )).rows[0]!;
    const targetRecord = (await db.query<{ id: string }>(
      `INSERT INTO workspace_records(workspace_id, resource_type, name, created_by)
       VALUES($1, 'crm_contacts', 'Target record', $2) RETURNING id`,
      [sharedWorkspace.id, target],
    )).rows[0]!;
    await db.query(
      `INSERT INTO record_relationships(workspace_id, source_record_id, target_record_id, relationship_type, created_by)
       VALUES($1, $2, $3, 'related_to', $4)`,
      [sharedWorkspace.id, collaboratorRecord.id, targetRecord.id, target],
    );
    await db.query(
      `INSERT INTO record_comments(workspace_id, record_id, author_id, body)
       VALUES($1, $2, $3, 'Remove this personal comment')`,
      [sharedWorkspace.id, collaboratorRecord.id, target],
    );
    await db.query(
      `INSERT INTO record_attachments(workspace_id, record_id, uploaded_by, storage_key, file_name, mime_type, size_bytes)
       VALUES($1, $2, $3, $4, 'delete.txt', 'text/plain', 1)`,
      [sharedWorkspace.id, collaboratorRecord.id, target, `test/${crypto.randomUUID()}`],
    );
    await db.query(
      `INSERT INTO workspace_invitations(workspace_id, email, token_hash, invited_by, expires_at)
       VALUES($1, 'invitee@example.test', $2, $3, NOW() + INTERVAL '1 day')`,
      [sharedWorkspace.id, crypto.randomUUID(), target],
    );
    await db.query(
      `INSERT INTO onboarding_documents(workspace_id, uploaded_by, file_name, mime_type, size_bytes, content)
       VALUES($1, $2, 'delete.pdf', 'application/pdf', 1, $3)`,
      [sharedWorkspace.id, target, Buffer.from('x')],
    );
    await db.query(
      `INSERT INTO webhook_endpoints(workspace_id, name, url, secret_hash, created_by)
       VALUES($1, 'Delete webhook', 'https://example.test/webhook', 'hash', $2)`,
      [sharedWorkspace.id, target],
    );
    // Simulates an older production table that was created before the current
    // migrations documented every RESTRICT reference to users.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS legacy_user_delete_blockers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT
      )
    `);
    await db.query(
      `INSERT INTO legacy_user_delete_blockers(user_id) VALUES($1)`,
      [target],
    );
    await db.exec(`
      CREATE TABLE IF NOT EXISTS legacy_workspace_delete_blockers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT
      )
    `);
    await db.query(
      `INSERT INTO legacy_workspace_delete_blockers(workspace_id) VALUES($1)`,
      [ownedWorkspace.id],
    );

    const result = await admin.deleteUserAndOwnedData(target);

    assert.equal(result?.deletedWorkspaceCount, 2);
    assert.equal(result?.deletedIntegrationCount, 0);
    assert.equal((await db.query('SELECT id FROM users WHERE id=$1', [target])).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM workspaces WHERE id=$1', [ownedWorkspace.id])).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM workspaces WHERE id=$1', [previouslyDeletedWorkspace.id])).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM workspaces WHERE id=$1', [sharedWorkspace.id])).rows.length, 1);
    assert.equal((await db.query('SELECT workspace_id FROM workspace_members WHERE user_id=$1', [target])).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM workspace_records WHERE id=$1', [targetRecord.id])).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM workspace_records WHERE id=$1', [collaboratorRecord.id])).rows.length, 1);
    for (const table of ['record_relationships', 'record_comments', 'record_attachments', 'workspace_invitations', 'onboarding_documents', 'webhook_endpoints']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0, `${table} should be removed`);
    }
    assert.equal((await db.query('SELECT * FROM legacy_user_delete_blockers WHERE user_id=$1', [target])).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM legacy_workspace_delete_blockers WHERE workspace_id=$1', [ownedWorkspace.id])).rows.length, 0);
  });

  it('keeps the final Super Admin protected', async () => {
    const onlySuperAdmin = await createUser(`super-${crypto.randomUUID()}@example.test`, 'admin');
    await db.query(`INSERT INTO admin_user_roles(user_id, role) VALUES($1, 'SUPER_ADMIN')`, [onlySuperAdmin]);
    await assert.rejects(admin.deleteUserAndOwnedData(onlySuperAdmin), /LAST_SUPER_ADMIN_DELETE_FORBIDDEN/);
    assert.equal((await db.query('SELECT id FROM users WHERE id=$1', [onlySuperAdmin])).rows.length, 1);
  });

  it('queues a durable deletion job and completes the account erasure outside the request', async () => {
    const target = await createUser(`queued-delete-${crypto.randomUUID()}@example.test`);
    const requestedBy = await createUser(`queued-admin-${crypto.randomUUID()}@example.test`, 'admin');
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Queued deletion workspace', $1) RETURNING id`,
      [target],
    )).rows[0]!;
    await db.query(
      `INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1, $2, 'owner')`,
      [workspace.id, target],
    );

    const queued = await admin.queueUserDeletion(target, requestedBy);
    assert.ok(queued);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.targetUserId, target);

    // Repeated clicks must attach to the same outstanding job, rather than
    // scheduling a second destructive operation.
    const duplicate = await admin.queueUserDeletion(target, requestedBy);
    assert.equal(duplicate?.id, queued.id);

    await adminUserDeletionWorker.runAdminUserDeletionWorkerCycle();

    const completed = await admin.getUserDeletionJob(queued.id);
    assert.equal(completed?.status, 'succeeded');
    assert.equal((await db.query('SELECT id FROM users WHERE id=$1', [target])).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM workspaces WHERE id=$1', [workspace.id])).rows.length, 0);
  });
});
