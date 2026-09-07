-- WeChat and SMS are not part of the current Lulu OmniChannel offering.
-- Remove unused identities first; this also makes the migration restart-safe.
-- Identities that are referenced by conversation history are retained below.
DELETE FROM omni_channel_identities ci
USING omni_channels c
WHERE ci.channel_id = c.id
  AND c.channel_type IN ('WECHAT', 'SMS')
  AND NOT EXISTS (SELECT 1 FROM omni_conversations v WHERE v.channel_identity_id = ci.id);

-- Remove unused channel records while preserving any historical rows safely.
DELETE FROM omni_channels c
WHERE c.channel_type IN ('WECHAT', 'SMS')
  AND NOT EXISTS (SELECT 1 FROM omni_conversations v WHERE v.channel_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM omni_channel_identities i WHERE i.channel_id = c.id);

-- If a deployment already contains historical records, hide them from all
-- channel discovery APIs without destroying conversation history.
UPDATE omni_channels
SET status = 'INACTIVE', updated_at = NOW()
WHERE channel_type IN ('WECHAT', 'SMS');
