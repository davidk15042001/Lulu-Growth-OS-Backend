-- Backfill the existing workspace email subsystem into canonical OmniChannel.
-- Legacy email tables remain authoritative for provider sync/send compatibility.

CREATE UNIQUE INDEX IF NOT EXISTS idx_omni_email_thread_mapping
  ON omni_conversations (channel_identity_id, (metadata ->> 'emailThreadId'))
  WHERE metadata ->> 'source' = 'email' AND metadata ? 'emailThreadId';

-- A connected mailbox is a real canonical Email identity. Credentials stay in
-- the encrypted email_accounts/provider-connection records and are never copied.
INSERT INTO omni_channel_identities (
  channel_id, workspace_id, provider_connection_id, provider_account_id,
  identity_type, external_identity_id, display_name, mode, status,
  default_language, capabilities, metadata
)
SELECT c.id,
       a.workspace_id,
       pc.id,
       pa.id,
       'MAILBOX',
       a.email_address,
       COALESCE(NULLIF(a.display_name, ''), a.email_address),
       'CUSTOMER_OWNED',
       CASE a.status
         WHEN 'connected' THEN 'ACTIVE'
         WHEN 'reauth_required' THEN 'AUTHORIZATION_REQUIRED'
         WHEN 'error' THEN 'ERROR'
         WHEN 'disconnected' THEN 'DISCONNECTED'
         ELSE 'CONNECTING'
       END,
       'en',
       jsonb_build_object(
         'messages.read', a.status = 'connected',
         'messages.send', a.status = 'connected',
         'messages.inbound_webhook', false
       ),
       jsonb_build_object('source', 'email_account', 'emailAccountId', a.id::text, 'provider', a.provider)
FROM email_accounts a
JOIN omni_channels c ON c.channel_type = 'EMAIL' AND c.provider = 'email'
LEFT JOIN provider_connections pc ON pc.source_type = 'email_account' AND pc.source_id = a.id
LEFT JOIN provider_accounts pa ON pa.provider_connection_id = pc.id
  AND pa.external_account_id = a.email_address
ON CONFLICT (channel_id, external_identity_id) DO UPDATE
SET provider_connection_id = COALESCE(EXCLUDED.provider_connection_id, omni_channel_identities.provider_connection_id),
    provider_account_id = COALESCE(EXCLUDED.provider_account_id, omni_channel_identities.provider_account_id),
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    capabilities = EXCLUDED.capabilities,
    updated_at = NOW();

-- Keep the aggregate channel health truthful for workspaces with a connected mailbox.
UPDATE omni_channels c
SET status = 'ACTIVE',
    capabilities = '{"messages.read":true,"messages.send":true}'::jsonb,
    updated_at = NOW()
WHERE c.channel_type = 'EMAIL'
  AND c.provider = 'email'
  AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.status = 'connected');

-- One canonical conversation per existing provider thread. No messages are sent.
INSERT INTO omni_conversations (
  workspace_id, channel_id, channel_identity_id, status, handling_mode,
  subject, last_message_at, first_message_at, metadata, created_at, updated_at
)
SELECT a.workspace_id,
       c.id,
       ci.id,
       'OPEN',
       'AI_ASSISTED',
       t.subject,
       t.latest_at,
       t.latest_at,
       jsonb_build_object(
         'source', 'email',
         'emailAccountId', a.id::text,
         'emailThreadId', t.id::text,
         'providerThreadId', t.provider_thread_id
       ),
       t.created_at,
       t.updated_at
FROM email_threads t
JOIN email_accounts a ON a.id = t.account_id
JOIN omni_channels c ON c.channel_type = 'EMAIL' AND c.provider = 'email'
JOIN omni_channel_identities ci ON ci.channel_id = c.id
  AND ci.workspace_id = a.workspace_id
  AND ci.external_identity_id = a.email_address
WHERE NOT EXISTS (
  SELECT 1
  FROM omni_conversations existing
  WHERE existing.channel_identity_id = ci.id
    AND existing.metadata ->> 'source' = 'email'
    AND existing.metadata ->> 'emailThreadId' = t.id::text
);

-- Preserve provider IDs, direction and timestamps while remaining idempotent.
INSERT INTO omni_messages (
  workspace_id, conversation_id, channel_id, channel_identity_id,
  direction, sender_type, message_type, text_content, status,
  provider_message_id, sent_at, received_at, created_at, metadata
)
SELECT conv.workspace_id,
       conv.id,
       conv.channel_id,
       conv.channel_identity_id,
       CASE em.direction WHEN 'inbound' THEN 'INBOUND' ELSE 'OUTBOUND' END,
       CASE em.direction WHEN 'inbound' THEN 'BUYER' ELSE 'USER' END,
       'TEXT',
       NULLIF(em.text_body, ''),
       CASE em.direction WHEN 'inbound' THEN 'RECEIVED' ELSE 'SENT' END,
       em.provider_message_id,
       em.sent_at,
       em.received_at,
       em.created_at,
       jsonb_build_object(
         'source', 'email',
         'emailMessageId', em.id::text,
         'providerThreadId', t.provider_thread_id,
         'internetMessageId', em.internet_message_id
       )
FROM email_messages em
JOIN email_threads t ON t.id = em.thread_id
JOIN email_accounts a ON a.id = em.account_id
JOIN omni_channel_identities ci ON ci.workspace_id = a.workspace_id
  AND ci.external_identity_id = a.email_address
JOIN omni_conversations conv ON conv.channel_identity_id = ci.id
  AND conv.metadata ->> 'source' = 'email'
  AND conv.metadata ->> 'emailThreadId' = t.id::text
ON CONFLICT DO NOTHING;

