# Admin operational data and support

The operational lists query the existing domain tables. Query failures propagate
to the API error handler; they are not successful empty lists.

| Admin view | Authoritative source |
| --- | --- |
| Websites / shops | workspace_sites; Shopify provider_accounts |
| AI agents | configured ai_agents workspace records plus agent_runs and agent_run_steps |
| Integrations | provider_connections; OAuth management remains its existing separate view |
| Approvals | approval_requests; this list does not grant authority to approve financial actions |
| Conversations | omni_conversations, omni_channels, omni_messages |
| Files | onboarding_documents, record_attachments, omni_message_attachments, local product_media references |
| Audit | audit_log and security_events |
| Jobs | background_jobs, domain_events, website_generation_jobs, email_sync_jobs, calendar_sync_jobs, workspace_content_refresh_jobs |
| Errors | failed domain operations and newly recorded API_ERROR security events |

## File access

The file inventory is a database-backed customer upload inventory, not a scan of
the server filesystem. It deliberately excludes configuration, credentials,
backups and unregistered/orphaned storage objects. Product media without byte
metadata has an unknown size, not a zero size.

Downloads require `files.read`, which is currently granted only to SUPER_ADMIN.
Requests specify a supported source and database record ID, never a storage key
or filesystem path. Downloads are attachments, are not cached, and are audited.
Direct download supports onboarding, record and locally stored OmniChannel
uploads up to 25 MiB. Provider-only media and other storage arrangements need
their existing provider access flow; no storage availability is fabricated.

## Support

Migration 0055 adds support_tickets and support_messages. Workspace APIs are
under `/workspaces/:workspaceId/support`; admin APIs are under `/admin/support`.

Workspace membership is required. Users can create tickets and can list, read
and reply only to their own tickets in that workspace. Support does not require
a paid subscription. Ticket and message bodies are validated and bounded;
workspace requests are rate-limited. Message history is paginated.

Platform `support.read` and `support.manage` are separate capabilities. The
SUPPORT_ADMIN and SUPER_ADMIN roles can respond. READ_ONLY_ADMIN can read but
cannot respond. Workspace owner/admin is not platform support authority.
Admin status changes and replies use transactions and audit records. Ticket
messages are displayed in Lulu; no notification email or external buyer message
is sent by this implementation.

Frontend routes: `/app/support` (Settings) and `/admin/support`. The existing
Admin Panel Support section embeds the same interface.

## Diagnostic boundaries

New HTTP 5xx errors are recorded without request bodies, query strings, provider
responses or stack traces. Existing security metadata filtering remains intact.
Database outages still require infrastructure logs because the database cannot
persist its own outage reliably. Historical filesystem logs are not imported.

Operational views do not automatically retry jobs, approve spending, execute
agents or reconnect external accounts. Those actions retain their existing
domain authorization and execution rules. A successful list query is not proof
of live external provider operation.
