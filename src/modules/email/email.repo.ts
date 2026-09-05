import { query, withTransaction } from '../../db/pool.js';
import { rotateStoredCredentials } from '../security/provider-credential.service.js';
import type { PoolClient } from 'pg';
import type { EmailAccount, EmailAccountCredential, EmailProvider, ProviderFolder, ProviderMessage } from './email.types.js';
import type { CreateDraftInput, CreateRuleInput, ListThreadsQuery, UpdateDraftInput, UpdateRuleInput } from './email.validator.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

const accountSelect = `
  id, workspace_id AS "workspaceId", provider, email_address AS "emailAddress",
  display_name AS "displayName", status, last_sync_at AS "lastSyncAt",
  last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const credentialSelect = `${accountSelect}, connected_by AS "connectedBy", encrypted_access_token AS "encryptedAccessToken",
  encrypted_refresh_token AS "encryptedRefreshToken", token_expires_at AS "tokenExpiresAt",
  encrypted_password AS "encryptedPassword", imap_host AS "imapHost", imap_port AS "imapPort",
  imap_secure AS "imapSecure", smtp_host AS "smtpHost", smtp_port AS "smtpPort", smtp_secure AS "smtpSecure"`;

async function appendEmailConnectedEvent(client: PoolClient, input: { workspaceId: string; userId: string; provider: string }, account: EmailAccount) {
  await appendDomainEvent({
    workspaceId: input.workspaceId,
    type: DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED,
    aggregateType: 'email_account',
    aggregateId: account.id,
    payload: { accountId: account.id, provider: input.provider, category: 'email' },
    metadata: { actorId: input.userId, source: 'email.connection' },
  }, client);
  return account;
}

export async function listAccounts(workspaceId: string) {
  const { rows } = await query<EmailAccount>(`SELECT ${accountSelect} FROM email_accounts WHERE workspace_id = $1 AND status <> 'disconnected' ORDER BY created_at`, [workspaceId]);
  return rows;
}

export async function findAccount(workspaceId: string, accountId: string) {
  const { rows } = await query<EmailAccountCredential>(`SELECT ${credentialSelect} FROM email_accounts WHERE workspace_id = $1 AND id = $2`, [workspaceId, accountId]);
  return rows[0] ? rotateStoredCredentials('email', workspaceId, accountId, rows[0]) : null;
}

export async function upsertOAuthAccount(input: {
  workspaceId: string; userId: string; provider: EmailProvider; emailAddress: string; displayName?: string | null;
  encryptedAccessToken: string; encryptedRefreshToken?: string | null; tokenExpiresAt?: string | null;
}) {
  return withTransaction(async (client) => {
    const { rows } = await query<EmailAccount>(
      `INSERT INTO email_accounts (workspace_id, connected_by, provider, email_address, display_name, encrypted_access_token, encrypted_refresh_token, token_expires_at, status)
       VALUES ($1,$2,$3,lower($4),$5,$6,$7,$8,'connected')
       ON CONFLICT (workspace_id, provider, email_address) DO UPDATE SET
         connected_by = EXCLUDED.connected_by, display_name = EXCLUDED.display_name,
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, email_accounts.encrypted_refresh_token),
         token_expires_at = EXCLUDED.token_expires_at, status = 'connected', last_error_code = NULL, last_error_message = NULL
       RETURNING ${accountSelect}`,
      [input.workspaceId, input.userId, input.provider, input.emailAddress, input.displayName ?? null, input.encryptedAccessToken, input.encryptedRefreshToken ?? null, input.tokenExpiresAt ?? null],
      client,
    );
    return appendEmailConnectedEvent(client, input, rows[0]!);
  });
}

export async function upsertImapAccount(input: {
  workspaceId: string; userId: string; emailAddress: string; displayName?: string | null; encryptedPassword: string;
  imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean;
}) {
  return withTransaction(async (client) => {
    const { rows } = await query<EmailAccount>(
      `INSERT INTO email_accounts (workspace_id, connected_by, provider, email_address, display_name, encrypted_password, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, status)
       VALUES ($1,$2,'imap',lower($3),$4,$5,$6,$7,$8,$9,$10,$11,'connected')
       ON CONFLICT (workspace_id, provider, email_address) DO UPDATE SET
         connected_by = EXCLUDED.connected_by, display_name = EXCLUDED.display_name, encrypted_password = EXCLUDED.encrypted_password,
         imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, imap_secure = EXCLUDED.imap_secure,
         smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, smtp_secure = EXCLUDED.smtp_secure,
         status = 'connected', last_error_code = NULL, last_error_message = NULL
       RETURNING ${accountSelect}`,
      [input.workspaceId, input.userId, input.emailAddress, input.displayName ?? null, input.encryptedPassword, input.imapHost, input.imapPort, input.imapSecure, input.smtpHost, input.smtpPort, input.smtpSecure],
      client,
    );
    return appendEmailConnectedEvent(client, { ...input, provider: 'imap' }, rows[0]!);
  });
}

export async function updateOAuthTokens(accountId: string, encryptedAccessToken: string, encryptedRefreshToken: string | null, tokenExpiresAt: string | null) {
  await query(`UPDATE email_accounts SET encrypted_access_token=$2, encrypted_refresh_token=COALESCE($3, encrypted_refresh_token), token_expires_at=$4, status='connected', last_error_code=NULL, last_error_message=NULL WHERE id=$1`, [accountId, encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt]);
}

export async function disconnectAccount(workspaceId: string, accountId: string) {
  const result = await query(`UPDATE email_accounts SET status='disconnected', encrypted_access_token=NULL, encrypted_refresh_token=NULL, encrypted_password=NULL WHERE workspace_id=$1 AND id=$2`, [workspaceId, accountId]);
  return result.rowCount > 0;
}

export async function setAccountStatus(accountId: string, status: string, errorCode?: string | null, errorMessage?: string | null) {
  await query(`UPDATE email_accounts SET status=$2, last_error_code=$3, last_error_message=$4 WHERE id=$1`, [accountId, status, errorCode ?? null, errorMessage?.slice(0, 2000) ?? null]);
}

export async function completeAccountSync(accountId: string, cursor?: string | null) {
  await query(`UPDATE email_accounts SET status='connected', sync_cursor=COALESCE($2,sync_cursor), last_sync_at=NOW(), last_error_code=NULL, last_error_message=NULL WHERE id=$1`, [accountId, cursor ?? null]);
}

export async function saveProviderData(accountId: string, folders: ProviderFolder[], messages: ProviderMessage[]) {
  await withTransaction(async (client) => {
    for (const folder of folders) await upsertFolder(client, accountId, folder);
    for (const message of messages) await upsertMessage(client, accountId, message);
  });
}

async function upsertFolder(client: PoolClient, accountId: string, folder: ProviderFolder) {
  await query(
    `INSERT INTO email_folders (account_id, provider_folder_id, parent_provider_folder_id, name, system_name, unread_count, total_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id, provider_folder_id) DO UPDATE SET parent_provider_folder_id=EXCLUDED.parent_provider_folder_id,
       name=EXCLUDED.name, system_name=EXCLUDED.system_name, unread_count=EXCLUDED.unread_count, total_count=EXCLUDED.total_count`,
    [accountId, folder.providerFolderId, folder.parentProviderFolderId ?? null, folder.name, folder.systemName ?? null, Math.max(0, folder.unreadCount), Math.max(0, folder.totalCount)], client,
  );
}

async function upsertMessage(client: PoolClient, accountId: string, message: ProviderMessage) {
  const participants = [...new Set([message.sender.address, ...message.recipients.map((item) => item.address), ...message.ccRecipients.map((item) => item.address)].filter(Boolean))];
  const latestAt = message.receivedAt ?? message.sentAt ?? new Date().toISOString();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO email_threads (account_id, provider_thread_id, subject, preview, participant_emails, folder_provider_ids, latest_at, unread, starred)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id, provider_thread_id) DO UPDATE SET
       subject=EXCLUDED.subject, preview=CASE WHEN EXCLUDED.latest_at >= email_threads.latest_at THEN EXCLUDED.preview ELSE email_threads.preview END,
       participant_emails=(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(email_threads.participant_emails || EXCLUDED.participant_emails)),
       folder_provider_ids=(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(email_threads.folder_provider_ids || EXCLUDED.folder_provider_ids)),
       latest_at=GREATEST(email_threads.latest_at, EXCLUDED.latest_at), unread=email_threads.unread OR EXCLUDED.unread,
       starred=email_threads.starred OR EXCLUDED.starred
     RETURNING id`,
    [accountId, message.providerThreadId, message.subject || '(No subject)', message.preview, JSON.stringify(participants), JSON.stringify(message.providerFolderIds), latestAt, !message.isRead, message.starred], client,
  );
  const threadId = rows[0]!.id;
  await query(
    `INSERT INTO email_messages (account_id, thread_id, provider_message_id, internet_message_id, direction, sender, recipients, cc_recipients, subject, text_body, html_body, provider_folder_ids, received_at, sent_at, is_read, starred)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
       thread_id=EXCLUDED.thread_id, internet_message_id=EXCLUDED.internet_message_id, sender=EXCLUDED.sender,
       recipients=EXCLUDED.recipients, cc_recipients=EXCLUDED.cc_recipients, subject=EXCLUDED.subject,
       text_body=EXCLUDED.text_body, html_body=EXCLUDED.html_body, provider_folder_ids=EXCLUDED.provider_folder_ids,
       received_at=EXCLUDED.received_at, sent_at=EXCLUDED.sent_at, is_read=EXCLUDED.is_read, starred=EXCLUDED.starred`,
    [accountId, threadId, message.providerMessageId, message.internetMessageId ?? null, message.direction, JSON.stringify(message.sender), JSON.stringify(message.recipients), JSON.stringify(message.ccRecipients), message.subject || '(No subject)', message.textBody, message.htmlBody ?? null, JSON.stringify(message.providerFolderIds), message.receivedAt ?? null, message.sentAt ?? null, message.isRead, message.starred], client,
  );
  await query(
    `UPDATE email_threads t SET
       unread=EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND NOT m.is_read),
       starred=EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.starred),
       folder_provider_ids=COALESCE((SELECT jsonb_agg(DISTINCT folder_id) FROM email_messages m CROSS JOIN LATERAL jsonb_array_elements(m.provider_folder_ids) AS folder_id WHERE m.thread_id=t.id),'[]'::jsonb)
     WHERE t.id=$1`,
    [threadId], client,
  );
}

export async function listFolders(workspaceId: string, accountId?: string) {
  const params: unknown[] = [workspaceId];
  const accountFilter = accountId ? `AND a.id = $${params.push(accountId)}` : '';
  const { rows } = await query(
    `SELECT f.id, f.account_id AS "accountId", f.provider_folder_id AS "providerFolderId", f.parent_provider_folder_id AS "parentProviderFolderId",
      f.name, f.system_name AS "systemName", f.unread_count AS "unreadCount", f.total_count AS "totalCount"
     FROM email_folders f JOIN email_accounts a ON a.id=f.account_id
     WHERE a.workspace_id=$1 AND a.status <> 'disconnected' ${accountFilter}
     ORDER BY CASE f.system_name WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafts' THEN 2 WHEN 'trash' THEN 9 ELSE 5 END, f.name`, params,
  );
  return rows;
}

export async function listThreads(workspaceId: string, filters: ListThreadsQuery) {
  const params: unknown[] = [workspaceId];
  const where = [`a.workspace_id=$1`, `a.status <> 'disconnected'`];
  if (filters.accountId) where.push(`t.account_id=$${params.push(filters.accountId)}`);
  if (filters.folderId) where.push(`t.folder_provider_ids ? $${params.push(filters.folderId)}`);
  if (filters.q) { params.push(`%${filters.q}%`); where.push(`(t.subject ILIKE $${params.length} OR t.preview ILIKE $${params.length} OR t.participant_emails::text ILIKE $${params.length})`); }
  if (filters.unread !== undefined) where.push(`t.unread=$${params.push(filters.unread)}`);
  if (filters.starred !== undefined) where.push(`t.starred=$${params.push(filters.starred)}`);
  const limitIndex = params.push(filters.limit);
  const offsetIndex = params.push(filters.offset);
  const { rows } = await query(
    `SELECT t.id, t.account_id AS "accountId", a.email_address AS "accountEmail", a.provider,
      t.provider_thread_id AS "providerThreadId", t.subject, t.preview, t.participant_emails AS "participantEmails",
      t.folder_provider_ids AS "folderProviderIds", t.latest_at AS "latestAt", t.unread, t.starred,
      COUNT(*) OVER()::integer AS "totalCount"
     FROM email_threads t JOIN email_accounts a ON a.id=t.account_id
     WHERE ${where.join(' AND ')} ORDER BY t.latest_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`, params,
  );
  return { items: rows, total: Number(rows[0]?.totalCount ?? 0), limit: filters.limit, offset: filters.offset };
}

export async function getThread(workspaceId: string, threadId: string) {
  const { rows } = await query(
    `SELECT t.id, t.account_id AS "accountId", a.email_address AS "accountEmail", a.provider,
      t.provider_thread_id AS "providerThreadId", t.subject, t.preview, t.participant_emails AS "participantEmails",
      t.folder_provider_ids AS "folderProviderIds", t.latest_at AS "latestAt", t.unread, t.starred
     FROM email_threads t JOIN email_accounts a ON a.id=t.account_id WHERE a.workspace_id=$1 AND t.id=$2`, [workspaceId, threadId],
  );
  if (!rows[0]) return null;
  const messages = await query(
    `SELECT m.id, m.provider_message_id AS "providerMessageId", m.internet_message_id AS "internetMessageId", m.direction,
      m.sender, m.recipients, m.cc_recipients AS "ccRecipients", m.subject, m.text_body AS "textBody",
      m.received_at AS "receivedAt", m.sent_at AS "sentAt", m.is_read AS "isRead", m.starred
     FROM email_messages m WHERE m.thread_id=$1 ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at)`, [threadId],
  );
  return { ...rows[0], messages: messages.rows };
}

export async function updateLocalMessageState(workspaceId: string, messageId: string, state: { isRead?: boolean; starred?: boolean }) {
  const sets: string[] = [];
  const params: unknown[] = [workspaceId, messageId];
  if (state.isRead !== undefined) sets.push(`is_read=$${params.push(state.isRead)}`);
  if (state.starred !== undefined) sets.push(`starred=$${params.push(state.starred)}`);
  const { rows } = await query(
    `UPDATE email_messages m SET ${sets.join(', ')} FROM email_accounts a
     WHERE a.id=m.account_id AND a.workspace_id=$1 AND m.id=$2
     RETURNING m.id, m.account_id AS "accountId", m.provider_message_id AS "providerMessageId", m.is_read AS "isRead", m.starred`, params,
  );
  if (rows[0]) {
    await query(
      `UPDATE email_threads t SET
         unread=EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND NOT m.is_read),
         starred=EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.starred)
       WHERE t.id=(SELECT thread_id FROM email_messages WHERE id=$1)`,
      [messageId],
    );
  }
  return rows[0] ?? null;
}

export async function findMessage(workspaceId: string, messageId: string) {
  const { rows } = await query(
    `SELECT m.id, m.account_id AS "accountId", m.thread_id AS "threadId", m.provider_message_id AS "providerMessageId",
      m.internet_message_id AS "internetMessageId", m.sender, m.recipients, m.cc_recipients AS "ccRecipients",
      m.subject, m.text_body AS "textBody", m.is_read AS "isRead", m.starred
     FROM email_messages m JOIN email_accounts a ON a.id=m.account_id WHERE a.workspace_id=$1 AND m.id=$2`, [workspaceId, messageId],
  );
  return rows[0] ?? null;
}

export async function createDraft(workspaceId: string, userId: string, input: CreateDraftInput, source: 'manual' | 'ai' | 'automation' = 'manual', aiMetadata: Record<string, unknown> = {}) {
  const { rows } = await query(
    `INSERT INTO email_drafts (workspace_id, account_id, thread_id, created_by, source, to_recipients, cc_recipients, subject, body_text, reply_to_provider_message_id, ai_metadata)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
     WHERE EXISTS (SELECT 1 FROM email_accounts WHERE id=$2 AND workspace_id=$1 AND status <> 'disconnected')
       AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM email_threads WHERE id=$3 AND account_id=$2))
     RETURNING id, workspace_id AS "workspaceId", account_id AS "accountId", thread_id AS "threadId", source, status,
       to_recipients AS "to", cc_recipients AS "cc", subject, body_text AS "bodyText", reply_to_provider_message_id AS "replyToProviderMessageId",
       ai_metadata AS "aiMetadata", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [workspaceId, input.accountId, input.threadId ?? null, userId, source, JSON.stringify(input.to), JSON.stringify(input.cc), input.subject, input.bodyText, input.replyToProviderMessageId ?? null, JSON.stringify(aiMetadata)],
  );
  return rows[0] ?? null;
}

export async function getDraft(workspaceId: string, draftId: string) {
  const { rows } = await query(
    `SELECT d.id, d.workspace_id AS "workspaceId", d.account_id AS "accountId", d.thread_id AS "threadId", d.source, d.status,
      d.to_recipients AS "to", d.cc_recipients AS "cc", d.subject, d.body_text AS "bodyText", d.reply_to_provider_message_id AS "replyToProviderMessageId",
      d.provider_message_id AS "providerMessageId", d.ai_metadata AS "aiMetadata", d.sent_at AS "sentAt",
      d.last_error_code AS "lastErrorCode", d.last_error_message AS "lastErrorMessage", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
     FROM email_drafts d WHERE d.workspace_id=$1 AND d.id=$2`, [workspaceId, draftId],
  );
  return rows[0] ?? null;
}

export async function listDrafts(workspaceId: string) {
  const { rows } = await query(
    `SELECT d.id, d.account_id AS "accountId", a.email_address AS "accountEmail", d.thread_id AS "threadId", d.source, d.status,
      d.to_recipients AS "to", d.cc_recipients AS "cc", d.subject, d.body_text AS "bodyText", d.reply_to_provider_message_id AS "replyToProviderMessageId",
      d.last_error_code AS "lastErrorCode", d.last_error_message AS "lastErrorMessage", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
     FROM email_drafts d JOIN email_accounts a ON a.id=d.account_id WHERE d.workspace_id=$1 AND d.status <> 'sent' ORDER BY d.updated_at DESC`, [workspaceId],
  );
  return rows;
}

export async function updateDraft(workspaceId: string, draftId: string, input: UpdateDraftInput) {
  const sets: string[] = [];
  const params: unknown[] = [workspaceId, draftId];
  if (input.to !== undefined) sets.push(`to_recipients=$${params.push(JSON.stringify(input.to))}`);
  if (input.cc !== undefined) sets.push(`cc_recipients=$${params.push(JSON.stringify(input.cc))}`);
  if (input.subject !== undefined) sets.push(`subject=$${params.push(input.subject)}`);
  if (input.bodyText !== undefined) sets.push(`body_text=$${params.push(input.bodyText)}`);
  if (input.replyToProviderMessageId !== undefined) sets.push(`reply_to_provider_message_id=$${params.push(input.replyToProviderMessageId ?? null)}`);
  if (!sets.length) return getDraft(workspaceId, draftId);
  await query(`UPDATE email_drafts SET ${sets.join(', ')} WHERE workspace_id=$1 AND id=$2 AND status='draft'`, params);
  return getDraft(workspaceId, draftId);
}

export async function markDraftSending(workspaceId: string, draftId: string) {
  const { rows } = await query(`UPDATE email_drafts SET status='sending', last_error_code=NULL, last_error_message=NULL WHERE workspace_id=$1 AND id=$2 AND status='draft' RETURNING id`, [workspaceId, draftId]);
  return Boolean(rows[0]);
}

export async function markDraftSent(draftId: string, providerMessageId?: string | null) {
  await query(`UPDATE email_drafts SET status='sent', provider_message_id=$2, sent_at=NOW(), last_error_code=NULL, last_error_message=NULL WHERE id=$1`, [draftId, providerMessageId ?? null]);
}

export async function markDraftFailed(draftId: string, code: string, message: string) {
  await query(`UPDATE email_drafts SET status='draft', last_error_code=$2, last_error_message=$3 WHERE id=$1`, [draftId, code, message.slice(0, 2000)]);
}

export async function listRules(workspaceId: string) {
  const { rows } = await query(`SELECT id, account_id AS "accountId", name, enabled, conditions, actions, last_run_at AS "lastRunAt", run_count AS "runCount", created_at AS "createdAt", updated_at AS "updatedAt" FROM email_automation_rules WHERE workspace_id=$1 ORDER BY updated_at DESC`, [workspaceId]);
  return rows;
}

export async function automationCandidates(workspaceId: string, accountId: string) {
  const { rows } = await query(
    `SELECT m.id, m.provider_message_id AS "providerMessageId", m.thread_id AS "threadId", m.sender, m.subject,
      m.text_body AS "textBody", m.is_read AS "isRead", m.starred
     FROM email_messages m JOIN email_threads t ON t.id=m.thread_id
     WHERE m.account_id=$2 AND t.account_id=$2 AND m.direction='inbound'
       AND COALESCE(m.received_at,m.created_at) > NOW() - INTERVAL '7 days'
       AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.id=$2 AND a.workspace_id=$1)
     ORDER BY COALESCE(m.received_at,m.created_at) DESC LIMIT 25`, [workspaceId, accountId],
  );
  return rows;
}

export async function automationWasProcessed(workspaceId: string, ruleId: string, messageId: string) {
  const { rows } = await query(`SELECT 1 FROM email_automation_runs WHERE workspace_id=$1 AND rule_id=$2 AND message_id=$3 LIMIT 1`, [workspaceId, ruleId, messageId]);
  return Boolean(rows[0]);
}

export async function recordRuleRun(workspaceId: string, ruleId: string, messageId: string) {
  await withTransaction(async (client) => {
    const inserted = await query(
      `INSERT INTO email_automation_runs (workspace_id,rule_id,message_id)
       SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM email_automation_rules WHERE id=$2 AND workspace_id=$1)
       ON CONFLICT (rule_id,message_id) DO NOTHING RETURNING id`,
      [workspaceId, ruleId, messageId], client,
    );
    if (inserted.rowCount) await query(`UPDATE email_automation_rules SET last_run_at=NOW(), run_count=run_count+1 WHERE id=$1 AND workspace_id=$2`, [ruleId, workspaceId], client);
  });
}

export async function createRule(workspaceId: string, userId: string, input: CreateRuleInput) {
  const { rows } = await query(`INSERT INTO email_automation_rules (workspace_id,account_id,created_by,name,enabled,conditions,actions) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, account_id AS "accountId", name, enabled, conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"`, [workspaceId, input.accountId ?? null, userId, input.name, input.enabled, JSON.stringify(input.conditions), JSON.stringify(input.actions)]);
  return rows[0]!;
}

export async function updateRule(workspaceId: string, ruleId: string, input: UpdateRuleInput) {
  const sets: string[] = []; const params: unknown[] = [workspaceId, ruleId];
  if (input.accountId !== undefined) sets.push(`account_id=$${params.push(input.accountId ?? null)}`);
  if (input.name !== undefined) sets.push(`name=$${params.push(input.name)}`);
  if (input.enabled !== undefined) sets.push(`enabled=$${params.push(input.enabled)}`);
  if (input.conditions !== undefined) sets.push(`conditions=$${params.push(JSON.stringify(input.conditions))}`);
  if (input.actions !== undefined) sets.push(`actions=$${params.push(JSON.stringify(input.actions))}`);
  if (sets.length) await query(`UPDATE email_automation_rules SET ${sets.join(', ')} WHERE workspace_id=$1 AND id=$2`, params);
  const { rows } = await query(`SELECT id, account_id AS "accountId", name, enabled, conditions, actions, last_run_at AS "lastRunAt", run_count AS "runCount", created_at AS "createdAt", updated_at AS "updatedAt" FROM email_automation_rules WHERE workspace_id=$1 AND id=$2`, [workspaceId, ruleId]);
  return rows[0] ?? null;
}

export async function deleteRule(workspaceId: string, ruleId: string) {
  return (await query(`DELETE FROM email_automation_rules WHERE workspace_id=$1 AND id=$2`, [workspaceId, ruleId])).rowCount > 0;
}

export async function createSyncJob(workspaceId: string, accountId: string, userId: string | null) {
  return withTransaction(async (client) => {
    const { rows } = await query<{ id: string; workspaceId: string; accountId: string; status: string }>(
      `WITH stale_jobs AS (
         UPDATE email_sync_jobs SET status='failed', error_code='EMAIL_SYNC_INTERRUPTED', error_message='Synchronization was interrupted and can be retried.', finished_at=NOW()
         WHERE account_id=$2 AND status IN ('queued','running') AND COALESCE(started_at,created_at) < NOW() - INTERVAL '15 minutes'
       )
       INSERT INTO email_sync_jobs (workspace_id,account_id,requested_by)
       SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM email_accounts WHERE workspace_id=$1 AND id=$2 AND status <> 'disconnected')
       ON CONFLICT (account_id) WHERE status IN ('queued','running') DO UPDATE SET requested_by=EXCLUDED.requested_by
       RETURNING id, workspace_id AS "workspaceId", account_id AS "accountId", status, folders_synced AS "foldersSynced", messages_synced AS "messagesSynced", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [workspaceId, accountId, userId],
      client,
    );
    const job = rows[0] ?? null;
    if (job) {
      await appendDomainEvent({
        workspaceId,
        type: DOMAIN_EVENT_TYPES.EMAIL_SYNC_REQUESTED,
        aggregateType: 'email_sync_job',
        aggregateId: job.id,
        payload: { jobId: job.id, accountId },
        metadata: { actorId: userId, source: 'email' },
        idempotencyKey: `email-sync:${job.id}:requested:v1`,
      }, client);
    }
    return job;
  });
}

export async function getSyncJob(workspaceId: string, accountId: string, jobId: string) {
  const { rows } = await query(`SELECT id, workspace_id AS "workspaceId", account_id AS "accountId", status, folders_synced AS "foldersSynced", messages_synced AS "messagesSynced", error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM email_sync_jobs WHERE workspace_id=$1 AND account_id=$2 AND id=$3`, [workspaceId, accountId, jobId]);
  return rows[0] ?? null;
}

export async function startSyncJob(jobId: string, staleSeconds = 60) {
  const result = await query(
    `UPDATE email_sync_jobs
     SET status='running', started_at=NOW(), error_code=NULL, error_message=NULL
     WHERE id=$1
       AND (status='queued' OR (status='running' AND started_at < NOW() - ($2::integer * INTERVAL '1 second')))`,
    [jobId, staleSeconds],
  );
  return result.rowCount > 0;
}
export async function finishSyncJob(jobId: string, folders: number, messages: number) {
  await withTransaction(async (client) => {
    const { rows } = await query<{ workspaceId: string; accountId: string }>(
      `UPDATE email_sync_jobs
       SET status='succeeded', folders_synced=$2, messages_synced=$3, finished_at=NOW()
       WHERE id=$1
       RETURNING workspace_id AS "workspaceId", account_id AS "accountId"`,
      [jobId, folders, messages],
      client,
    );
    const job = rows[0];
    if (job) await appendDomainEvent({
      workspaceId: job.workspaceId,
      type: DOMAIN_EVENT_TYPES.EMAIL_SYNC_COMPLETED,
      aggregateType: 'email_sync_job',
      aggregateId: jobId,
      payload: { jobId, accountId: job.accountId, folders, messages },
      metadata: { source: 'email' },
      idempotencyKey: `email-sync:${jobId}:completed:v1`,
    }, client);
  });
}
export async function failSyncJob(jobId: string, code: string, message: string) {
  await withTransaction(async (client) => {
    const { rows } = await query<{ workspaceId: string; accountId: string }>(
      `UPDATE email_sync_jobs
       SET status='failed', error_code=$2, error_message=$3, finished_at=NOW()
       WHERE id=$1
       RETURNING workspace_id AS "workspaceId", account_id AS "accountId"`,
      [jobId, code, message.slice(0, 2000)],
      client,
    );
    const job = rows[0];
    if (job) await appendDomainEvent({
      workspaceId: job.workspaceId,
      type: DOMAIN_EVENT_TYPES.EMAIL_SYNC_FAILED,
      aggregateType: 'email_sync_job',
      aggregateId: jobId,
      payload: { jobId, accountId: job.accountId, code, message: message.slice(0, 2000) },
      metadata: { source: 'email' },
      idempotencyKey: `email-sync:${jobId}:failed:v1`,
    }, client);
  });
}

export async function dueAccountIds(intervalMinutes: number) {
  const { rows } = await query<{ id: string; workspaceId: string }>(`SELECT id, workspace_id AS "workspaceId" FROM email_accounts WHERE (status IN ('connected','error') OR (status='syncing' AND updated_at < NOW() - INTERVAL '15 minutes')) AND (last_sync_at IS NULL OR last_sync_at < NOW() - ($1::integer * INTERVAL '1 minute')) ORDER BY COALESCE(last_sync_at, to_timestamp(0)) LIMIT 20`, [intervalMinutes]);
  return rows;
}
