import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { decryptSecret, encryptSecret } from '../../utils/secret-box.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { upsertLegacyPlatformControlConnection } from './provider.repo.js';
import {
  asTwilioAddress,
  createTwilioSubaccount,
  createWhatsAppSender,
  getWhatsAppContentTemplateApproval,
  listWhatsAppSenders,
  type TwilioRestCredentials,
  type TwilioWhatsAppSender,
} from './twilio.client.js';

type WorkspaceTwilioAccount = {
  workspaceId: string;
  twilioAccountSid: string;
  encryptedAuthToken: string;
  wabaId: string;
  phoneNumberId: string;
  senderSid: string | null;
  senderAddress: string;
  displayName: string;
  senderStatus: string;
  contentSid: string | null;
  contentApprovalStatus: string | null;
  status: 'PROVISIONING' | 'CONNECTED' | 'ERROR' | 'DISABLED' | 'DISCONNECTED';
  lastError: string | null;
  updatedAt: string;
};

const accountSelect = `workspace_id AS "workspaceId",twilio_account_sid AS "twilioAccountSid",
  encrypted_auth_token AS "encryptedAuthToken",waba_id AS "wabaId",phone_number_id AS "phoneNumberId",
  sender_sid AS "senderSid",sender_address AS "senderAddress",display_name AS "displayName",
  sender_status AS "senderStatus",content_sid AS "contentSid",content_approval_status AS "contentApprovalStatus",
  status,last_error AS "lastError",updated_at AS "updatedAt"`;

function normalizePhoneNumber(value: string) {
  const phone = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) {
    throw new AppError(422, 'TWILIO_WHATSAPP_PHONE_INVALID', 'Use an international WhatsApp phone number in E.164 format, for example +491701234567.');
  }
  return phone;
}

function workspaceAuth(account: WorkspaceTwilioAccount): TwilioRestCredentials {
  return { accountSid: account.twilioAccountSid, username: account.twilioAccountSid, password: decryptSecret(account.encryptedAuthToken) };
}

function senderIsOnline(sender: TwilioWhatsAppSender) {
  return sender.status.toUpperCase() === 'ONLINE';
}

async function loadWorkspaceAccount(workspaceId: string, client?: PoolClient) {
  const { rows } = await query<WorkspaceTwilioAccount>(
    `SELECT ${accountSelect} FROM twilio_workspace_accounts WHERE workspace_id=$1`,
    [workspaceId],
    client,
  );
  return rows[0] ?? null;
}

async function refreshWorkspaceSenderStatus(account: WorkspaceTwilioAccount) {
  if (account.status === 'DISABLED' || account.status === 'DISCONNECTED') return account;
  const lastCheck = Date.parse(account.updatedAt);
  if (Number.isFinite(lastCheck) && Date.now() - lastCheck < 60_000) return account;
  try {
    const sender = (await listWhatsAppSenders(workspaceAuth(account)))
      .find((item) => item.senderId.toLowerCase() === account.senderAddress.toLowerCase());
    if (!sender) return account;
    const nextStatus = senderIsOnline(sender) ? 'CONNECTED' : 'PROVISIONING';
    if (account.senderSid === sender.sid && account.senderStatus === sender.status && account.status === nextStatus) {
      const { rows } = await query<WorkspaceTwilioAccount>(
        `UPDATE twilio_workspace_accounts SET updated_at=NOW() WHERE workspace_id=$1 RETURNING ${accountSelect}`,
        [account.workspaceId],
      );
      return rows[0] ?? account;
    }
    return withTransaction(async (client) => {
      const { rows } = await query<WorkspaceTwilioAccount>(
        `UPDATE twilio_workspace_accounts SET sender_sid=$2,sender_status=$3,status=$4,
           last_error=NULL,updated_at=NOW() WHERE workspace_id=$1 RETURNING ${accountSelect}`,
        [account.workspaceId, sender.sid, sender.status, nextStatus],
        client,
      );
      const refreshed = rows[0] ?? account;
      await upsertWorkspaceIdentity({ account: refreshed, client });
      await upsertWorkspacePlatform({ workspaceId: account.workspaceId, account: refreshed, connected: nextStatus === 'CONNECTED', client });
      return refreshed;
    });
  } catch {
    // A status refresh must never turn a working fallback into a page error.
    // Registration errors remain persisted by the provisioning command itself.
    return account;
  }
}

async function upsertWorkspacePlatform(input: {
  workspaceId: string;
  account: WorkspaceTwilioAccount;
  connected: boolean;
  client: PoolClient;
}) {
  const connectionStatus = input.connected ? 'connected' : input.account.status === 'ERROR' ? 'error' : 'pending';
  const { rows } = await query<{ id: string }>(
    `INSERT INTO workspace_platforms(
       workspace_id,integration_key,name,category,connection_status,external_account_id,
       granted_scopes,settings,last_error
     ) VALUES($1,'whatsapp','WhatsApp','messaging',$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT(workspace_id,integration_key) WHERE integration_key IS NOT NULL AND deleted_at IS NULL
     DO UPDATE SET name='WhatsApp',category='messaging',connection_status=EXCLUDED.connection_status,
       external_account_id=EXCLUDED.external_account_id,granted_scopes=EXCLUDED.granted_scopes,
       settings=EXCLUDED.settings,last_error=EXCLUDED.last_error,updated_at=NOW()
     RETURNING id`,
    [
      input.workspaceId,
      connectionStatus,
      input.account.senderAddress,
      ['whatsapp_business_management', 'whatsapp_business_messaging'],
      JSON.stringify({ transport: 'twilio', senderStatus: input.account.senderStatus, customerOwned: true }),
      input.account.lastError,
    ],
    input.client,
  );
  const platformId = rows[0]?.id;
  if (!platformId) throw new Error('WhatsApp platform connection could not be saved.');
  await upsertLegacyPlatformControlConnection({
    workspaceId: input.workspaceId,
    platformId,
    integrationKey: 'whatsapp',
    name: 'WhatsApp',
    category: 'messaging',
    connectionStatus,
    externalAccountId: input.account.senderAddress,
    grantedScopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    lastError: input.account.lastError,
    credentialReference: `twilio_workspace_accounts:${input.workspaceId}`,
  }, input.client);
}

async function upsertWorkspaceIdentity(input: { account: WorkspaceTwilioAccount; client: PoolClient }) {
  const active = input.account.status === 'CONNECTED' && input.account.senderStatus.toUpperCase() === 'ONLINE';
  const { rows } = await query<{ id: string }>(
    `INSERT INTO omni_channel_identities(
       channel_id,workspace_id,identity_type,external_identity_id,display_name,mode,status,
       capabilities,metadata
     ) SELECT id,$1,'WHATSAPP_SENDER',$2,$3,'CUSTOMER_OWNED',$4,
       '{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"messages.delivery_status":true}'::jsonb,
       $5::jsonb
     FROM omni_channels WHERE channel_type='WHATSAPP' AND provider='twilio' AND status='ACTIVE'
     ON CONFLICT(channel_id,external_identity_id) DO UPDATE SET
       display_name=EXCLUDED.display_name,status=EXCLUDED.status,capabilities=EXCLUDED.capabilities,
       metadata=EXCLUDED.metadata,updated_at=NOW()
     WHERE omni_channel_identities.workspace_id=EXCLUDED.workspace_id
     RETURNING id`,
    [
      input.account.workspaceId,
      input.account.senderAddress,
      input.account.displayName,
      active ? 'ACTIVE' : 'CONNECTING',
      JSON.stringify({
        provider: 'twilio',
        customerOwned: true,
        twilioAccountSid: input.account.twilioAccountSid,
        senderSid: input.account.senderSid,
        wabaId: input.account.wabaId,
        phoneNumberId: input.account.phoneNumberId,
      }),
    ],
    input.client,
  );
  if (!rows[0]) throw new AppError(409, 'TWILIO_SENDER_ALREADY_ASSIGNED', 'This WhatsApp sender is already assigned to another workspace.');
  return rows[0].id;
}

export async function getAdminWhatsAppConfiguration() {
  const [configuration, senders] = await Promise.all([
    query<{ identityId: string | null; address: string | null; displayName: string | null; status: string | null }>(
      `SELECT c.admin_whatsapp_identity_id AS "identityId",i.external_identity_id AS address,
        i.display_name AS "displayName",i.status
       FROM twilio_platform_configuration c
       LEFT JOIN omni_channel_identities i ON i.id=c.admin_whatsapp_identity_id
       WHERE c.singleton=TRUE`,
    ),
    listWhatsAppSenders(),
  ]);
  return {
    configured: Boolean(configuration.rows[0]?.identityId && configuration.rows[0]?.status === 'ACTIVE'),
    identity: configuration.rows[0] ?? null,
    availableSenders: senders.map((sender) => ({
      sid: sender.sid,
      address: sender.senderId,
      displayName: sender.displayName,
      status: sender.status,
    })),
  };
}

export async function configureAdminWhatsAppSender(input: { address: string; displayName: string; actorId: string }) {
  const address = asTwilioAddress('WHATSAPP', normalizePhoneNumber(input.address));
  const senders = await listWhatsAppSenders();
  const sender = senders.find((item) => item.senderId.toLowerCase() === address.toLowerCase());
  if (!sender) throw new AppError(409, 'TWILIO_ADMIN_SENDER_NOT_REGISTERED', 'This number is not registered as a WhatsApp sender in the Lulu Twilio account.');
  if (!senderIsOnline(sender)) throw new AppError(409, 'TWILIO_ADMIN_SENDER_NOT_ONLINE', 'The selected WhatsApp sender is not online yet.', { senderStatus: sender.status });

  const identity = await withTransaction(async (client) => {
    const previous = await query<{ identityId: string | null }>(
      `SELECT admin_whatsapp_identity_id AS "identityId" FROM twilio_platform_configuration WHERE singleton=TRUE FOR UPDATE`,
      [],
      client,
    );
    const { rows } = await query<{ id: string; external_identity_id: string; display_name: string; status: string }>(
      `INSERT INTO omni_channel_identities(
         channel_id,workspace_id,identity_type,external_identity_id,display_name,mode,status,capabilities,metadata
       ) SELECT id,NULL,'PLATFORM_SENDER',$1,$2,'LULU_MANAGED','ACTIVE',
         '{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"messages.delivery_status":true}'::jsonb,
         $3::jsonb
       FROM omni_channels WHERE channel_type='WHATSAPP' AND provider='twilio' AND status='ACTIVE'
       ON CONFLICT(channel_id,external_identity_id) DO UPDATE SET
         display_name=EXCLUDED.display_name,status='ACTIVE',capabilities=EXCLUDED.capabilities,
         metadata=EXCLUDED.metadata,updated_at=NOW()
       WHERE omni_channel_identities.workspace_id IS NULL
       RETURNING id,external_identity_id,display_name,status`,
      [address, input.displayName, JSON.stringify({ provider: 'twilio', adminFallback: true, senderSid: sender.sid })],
      client,
    );
    const next = rows[0];
    if (!next) throw new AppError(409, 'TWILIO_ADMIN_SENDER_ALREADY_ASSIGNED', 'This sender is already owned by a customer workspace.');
    await query(
      `INSERT INTO twilio_platform_configuration(singleton,admin_whatsapp_identity_id,configured_by)
       VALUES(TRUE,$1,$2)
       ON CONFLICT(singleton) DO UPDATE SET admin_whatsapp_identity_id=EXCLUDED.admin_whatsapp_identity_id,
         configured_by=EXCLUDED.configured_by,updated_at=NOW()`,
      [next.id, input.actorId],
      client,
    );
    if (previous.rows[0]?.identityId && previous.rows[0].identityId !== next.id) {
      await query(`UPDATE omni_channel_identities SET status='DISCONNECTED',updated_at=NOW() WHERE id=$1 AND workspace_id IS NULL`, [previous.rows[0].identityId], client);
    }
    await query(
      `INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data)
       VALUES(NULL,$1,'twilio.admin_sender_configured','omni_channel_identity',$2,$3::jsonb)`,
      [input.actorId, next.id, JSON.stringify({ address, displayName: input.displayName, senderStatus: sender.status })],
      client,
    );
    return next;
  });
  return { id: identity.id, address: identity.external_identity_id, displayName: identity.display_name, status: identity.status };
}

export async function getWorkspaceWhatsAppConnection(workspaceId: string) {
  const [permission, storedAccount, fallback] = await Promise.all([
    query<{ allowed: boolean }>(`SELECT allowed FROM workspace_oauth_self_service_permissions WHERE workspace_id=$1 AND provider='whatsapp'`, [workspaceId]),
    loadWorkspaceAccount(workspaceId),
    query<{ address: string; displayName: string; status: string }>(
      `SELECT COALESCE(NULLIF(i.metadata->>'phone',''),i.external_identity_id) AS address,
              i.display_name AS "displayName",i.status
       FROM unifyport_platform_configuration c
       JOIN omni_channel_identities i ON i.id=c.admin_whatsapp_identity_id
       JOIN omni_channels channel ON channel.id=i.channel_id
       WHERE c.singleton=TRUE AND channel.provider='unifyport' AND channel.channel_type='WHATSAPP'`,
    ),
  ]);
  const allowed = permission.rows[0]?.allowed === true;
  const account = storedAccount && allowed ? await refreshWorkspaceSenderStatus(storedAccount) : storedAccount;
  const embeddedSignupConfigured = Boolean(
    env.META_CLIENT_ID && env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID && env.TWILIO_PARTNER_SOLUTION_ID,
  );
  return {
    selfServiceAllowed: allowed,
    embeddedSignupConfigured,
    embeddedSignup: allowed && embeddedSignupConfigured ? {
      appId: env.META_CLIENT_ID!,
      configurationId: env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID!,
      partnerSolutionId: env.TWILIO_PARTNER_SOLUTION_ID!,
      graphVersion: env.META_GRAPH_VERSION,
    } : null,
    customerConnection: account ? {
      address: account.senderAddress,
      displayName: account.displayName,
      senderStatus: account.senderStatus,
      contentSid: account.contentSid,
      contentApprovalStatus: account.contentApprovalStatus,
      status: account.status,
      lastError: account.lastError,
    } : null,
    adminFallback: fallback.rows[0] ? {
      configured: fallback.rows[0].status === 'ACTIVE',
      address: fallback.rows[0].address,
      displayName: fallback.rows[0].displayName,
      status: fallback.rows[0].status,
    } : { configured: false, address: null, displayName: null, status: 'NOT_CONFIGURED' },
    effectiveMode: allowed && account?.status === 'CONNECTED' && account.senderStatus.toUpperCase() === 'ONLINE'
      ? 'CUSTOMER_OWNED'
      : 'LULU_MANAGED',
  };
}

export async function listWorkspaceWhatsAppAccounts() {
  const { rows } = await query<{
    workspaceId: string; workspaceName: string; senderAddress: string; displayName: string;
    senderStatus: string; status: string; contentSid: string | null; contentApprovalStatus: string | null; lastError: string | null;
  }>(`SELECT a.workspace_id AS "workspaceId",w.name AS "workspaceName",a.sender_address AS "senderAddress",
      a.display_name AS "displayName",a.sender_status AS "senderStatus",a.status,
      a.content_sid AS "contentSid",a.content_approval_status AS "contentApprovalStatus",a.last_error AS "lastError"
    FROM twilio_workspace_accounts a JOIN workspaces w ON w.id=a.workspace_id AND w.deleted_at IS NULL
    ORDER BY w.name,a.updated_at DESC`);
  return rows;
}

export async function configureWorkspaceWhatsAppTemplate(input: { workspaceId: string; contentSid: string; actorId: string }) {
  const account = await loadWorkspaceAccount(input.workspaceId);
  if (!account) throw new AppError(404, 'TWILIO_WORKSPACE_ACCOUNT_NOT_FOUND', 'This workspace does not have a private Twilio WhatsApp account.');
  const template = await getWhatsAppContentTemplateApproval(input.contentSid, workspaceAuth(account));
  if (template.accountSid && template.accountSid !== account.twilioAccountSid) {
    throw new AppError(409, 'TWILIO_CONTENT_ACCOUNT_MISMATCH', 'The WhatsApp template belongs to a different Twilio account.');
  }
  if (template.approvalStatus !== 'APPROVED') {
    throw new AppError(409, 'TWILIO_CONTENT_NOT_APPROVED', 'The selected WhatsApp template has not been approved by Meta.', {
      approvalStatus: template.approvalStatus, rejectionReason: template.rejectionReason,
    });
  }
  const { rows } = await query<WorkspaceTwilioAccount>(
    `UPDATE twilio_workspace_accounts SET content_sid=$2,content_approval_status=$3,updated_at=NOW()
     WHERE workspace_id=$1 RETURNING ${accountSelect}`,
    [input.workspaceId, template.sid, template.approvalStatus],
  );
  await recordSecurityEvent({ eventType: 'ADMIN_ACTION', userId: input.actorId, workspaceId: input.workspaceId, metadata: {
    action: 'whatsapp.workspace_template_configured', contentSid: template.sid, templateName: template.friendlyName,
  } });
  return rows[0] ? {
    workspaceId: rows[0].workspaceId, contentSid: rows[0].contentSid,
    contentApprovalStatus: rows[0].contentApprovalStatus,
  } : null;
}

export async function provisionWorkspaceWhatsApp(input: {
  workspaceId: string;
  userId: string;
  phoneNumber: string;
  displayName: string;
  wabaId: string;
  phoneNumberId: string;
}) {
  if (!env.META_CLIENT_ID || !env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || !env.TWILIO_PARTNER_SOLUTION_ID) {
    throw new AppError(503, 'WHATSAPP_EMBEDDED_SIGNUP_NOT_CONFIGURED', 'WhatsApp self-service is awaiting Lulu Tech Provider configuration.');
  }
  if (!env.TWILIO_WEBHOOK_URL) throw new AppError(503, 'TWILIO_WEBHOOK_URL_MISSING', 'Twilio webhook delivery is not configured.');
  const address = asTwilioAddress('WHATSAPP', normalizePhoneNumber(input.phoneNumber));

  const result = await withTransaction(async (client) => {
    const workspace = await query<{ id: string; name: string }>(`SELECT id,name FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [input.workspaceId], client);
    if (!workspace.rows[0]) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');
    const permission = await query<{ allowed: boolean }>(
      `SELECT allowed FROM workspace_oauth_self_service_permissions WHERE workspace_id=$1 AND provider='whatsapp'`,
      [input.workspaceId],
      client,
    );
    if (permission.rows[0]?.allowed !== true) throw new AppError(403, 'OAUTH_PROVIDER_ADMIN_MANAGED', 'An administrator must enable WhatsApp self-service for this workspace.');

    let account = await loadWorkspaceAccount(input.workspaceId, client);
    if (account && account.senderAddress.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(409, 'TWILIO_WORKSPACE_SENDER_CHANGE_REQUIRES_DISCONNECT', 'Disconnect the existing workspace sender before registering a different number.');
    }
    if (!account) {
      const created = await createTwilioSubaccount(`Lulu · ${workspace.rows[0].name}`);
      const inserted = await query<WorkspaceTwilioAccount>(
        `INSERT INTO twilio_workspace_accounts(
           workspace_id,twilio_account_sid,encrypted_auth_token,waba_id,phone_number_id,
           sender_address,display_name,sender_status,status,connected_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATING','PROVISIONING',$8)
         RETURNING ${accountSelect}`,
        [input.workspaceId, created.accountSid, encryptSecret(created.authToken), input.wabaId, input.phoneNumberId, address, input.displayName, input.userId],
        client,
      );
      account = inserted.rows[0] ?? null;
    } else {
      const updated = await query<WorkspaceTwilioAccount>(
        `UPDATE twilio_workspace_accounts SET waba_id=$2,phone_number_id=$3,display_name=$4,
           status='PROVISIONING',last_error=NULL,connected_by=$5,updated_at=NOW()
         WHERE workspace_id=$1 RETURNING ${accountSelect}`,
        [input.workspaceId, input.wabaId, input.phoneNumberId, input.displayName, input.userId],
        client,
      );
      account = updated.rows[0] ?? account;
    }
    if (!account) throw new Error('Twilio workspace account could not be persisted.');

    try {
      const auth = workspaceAuth(account);
      const existing = (await listWhatsAppSenders(auth)).find((sender) => sender.senderId.toLowerCase() === address.toLowerCase());
      const sender = existing ?? await createWhatsAppSender({ auth, address, wabaId: input.wabaId, displayName: input.displayName });
      const connected = senderIsOnline(sender);
      const updated = await query<WorkspaceTwilioAccount>(
        `UPDATE twilio_workspace_accounts SET sender_sid=$2,sender_status=$3,status=$4,last_error=NULL,updated_at=NOW()
         WHERE workspace_id=$1 RETURNING ${accountSelect}`,
        [input.workspaceId, sender.sid, sender.status, connected ? 'CONNECTED' : 'PROVISIONING'],
        client,
      );
      account = updated.rows[0] ?? account;
      await upsertWorkspaceIdentity({ account, client });
      await upsertWorkspacePlatform({ workspaceId: input.workspaceId, account, connected, client });
      await query(
        `INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data)
         VALUES($1,$2,'whatsapp.workspace_sender_registered','twilio_workspace_account',$1,$3::jsonb)`,
        [input.workspaceId, input.userId, JSON.stringify({ senderAddress: address, senderStatus: sender.status, twilioAccountSid: account.twilioAccountSid })],
        client,
      );
      return { account, error: null as Error | null };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Twilio sender registration failed.';
      await query(
        `UPDATE twilio_workspace_accounts SET status='ERROR',last_error=$2,updated_at=NOW() WHERE workspace_id=$1`,
        [input.workspaceId, message],
        client,
      );
      return { account, error: error instanceof Error ? error : new Error(message) };
    }
  });
  if (result.error) throw result.error;
  return getWorkspaceWhatsAppConnection(input.workspaceId);
}

export async function disconnectWorkspaceWhatsApp(workspaceId: string, userId: string) {
  await withTransaction(async (client) => {
    const account = await loadWorkspaceAccount(workspaceId, client);
    if (!account) return;
    await query(`UPDATE twilio_workspace_accounts SET status='DISABLED',updated_at=NOW() WHERE workspace_id=$1`, [workspaceId], client);
    await query(
      `UPDATE omni_channel_identities SET status='DISCONNECTED',updated_at=NOW()
       WHERE workspace_id=$1 AND external_identity_id=$2`,
      [workspaceId, account.senderAddress],
      client,
    );
    await query(
      `UPDATE workspace_platforms SET connection_status='disconnected',last_error=NULL,updated_at=NOW()
       WHERE workspace_id=$1 AND integration_key='whatsapp' AND deleted_at IS NULL`,
      [workspaceId],
      client,
    );
    await query(
      `UPDATE provider_connections SET status='DISCONNECTED',authorization_state='NOT_AUTHORIZED',
         health_status='DISCONNECTED',updated_at=NOW()
       WHERE workspace_id=$1 AND provider_key='whatsapp'`,
      [workspaceId],
      client,
    );
  });
  await recordSecurityEvent({ eventType: 'ADMIN_ACTION', userId, workspaceId, metadata: { action: 'whatsapp.workspace_sender_disconnected' } });
  return getWorkspaceWhatsAppConnection(workspaceId);
}

export async function getWorkspaceTwilioCredentials(workspaceId: string, accountSid?: string | null) {
  const { rows } = await query<WorkspaceTwilioAccount>(
    `SELECT ${accountSelect} FROM twilio_workspace_accounts
     WHERE workspace_id=$1 AND status IN ('CONNECTED','PROVISIONING')
       AND ($2::text IS NULL OR twilio_account_sid=$2)`,
    [workspaceId, accountSid ?? null],
  );
  return rows[0] ? workspaceAuth(rows[0]) : null;
}

export async function getWorkspaceTwilioContentSid(workspaceId: string, accountSid?: string | null) {
  const { rows } = await query<{ contentSid: string | null; approvalStatus: string | null }>(
    `SELECT content_sid AS "contentSid",content_approval_status AS "approvalStatus"
     FROM twilio_workspace_accounts WHERE workspace_id=$1 AND status='CONNECTED'
       AND ($2::text IS NULL OR twilio_account_sid=$2)`,
    [workspaceId, accountSid ?? null],
  );
  return rows[0]?.approvalStatus === 'APPROVED' ? rows[0].contentSid : null;
}

export async function getTwilioWebhookAuthToken(accountSid?: string | null) {
  if (!accountSid || accountSid === env.TWILIO_ACCOUNT_SID) return env.TWILIO_AUTH_TOKEN ?? null;
  const { rows } = await query<{ encryptedAuthToken: string }>(
    `SELECT encrypted_auth_token AS "encryptedAuthToken" FROM twilio_workspace_accounts
     WHERE twilio_account_sid=$1 AND status IN ('PROVISIONING','CONNECTED','ERROR','DISABLED')`,
    [accountSid],
  );
  return rows[0] ? decryptSecret(rows[0].encryptedAuthToken) : null;
}
