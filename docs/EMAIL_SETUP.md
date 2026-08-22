# Lulu Email workspace setup

The email workspace supports Google/Gmail, Microsoft 365/Outlook and standards-based IMAP/SMTP accounts. Provider credentials are encrypted at rest with the server secret. Message sending is never performed by an automation rule: rules may prepare drafts, and an authenticated workspace editor must confirm the send action.

## Server configuration

Set these values in the backend production environment:

```env
OAUTH_CALLBACK_BASE_URL=https://lulu-ai.cn/api/v1
FRONTEND_BASE_URL=https://lulu-ai.cn

EMAIL_GOOGLE_CLIENT_ID=
EMAIL_GOOGLE_CLIENT_SECRET=
EMAIL_MICROSOFT_CLIENT_ID=
EMAIL_MICROSOFT_CLIENT_SECRET=
EMAIL_MICROSOFT_TENANT=common

EMAIL_SYNC_INTERVAL_MINUTES=15
EMAIL_SYNC_MESSAGE_LIMIT=100
```

Keep `JWT_SECRET` stable. It is also used to derive the encryption key for stored provider credentials; changing it without a credential migration requires every email account to be reconnected.

## Google / Gmail

1. Enable the Gmail API in the Google Cloud project.
2. Configure the OAuth consent screen and add the application domain.
3. Add this exact authorized redirect URI:

   `https://lulu-ai.cn/api/v1/email/oauth/google/callback`

4. Configure the client ID and secret as `EMAIL_GOOGLE_CLIENT_ID` and `EMAIL_GOOGLE_CLIENT_SECRET`.
5. Submit the app for the verification and security review required for the `gmail.modify` restricted scope before opening the integration to external customers.

Reference: [Google Gmail server-side OAuth](https://developers.google.com/workspace/gmail/api/auth/web-server) and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Microsoft 365 / Outlook

1. Register a web application in Microsoft Entra ID.
2. Add delegated permissions `User.Read`, `Mail.ReadWrite` and `Mail.Send`.
3. Add this exact web redirect URI:

   `https://lulu-ai.cn/api/v1/email/oauth/microsoft/callback`

4. Create a client secret and configure `EMAIL_MICROSOFT_CLIENT_ID` and `EMAIL_MICROSOFT_CLIENT_SECRET`.
5. Keep `EMAIL_MICROSOFT_TENANT=common` for both work/school and personal Microsoft accounts, or set a tenant identifier to restrict access to one organization.

Reference: [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) and [Microsoft Graph mail permissions](https://learn.microsoft.com/en-us/graph/permissions-reference).

## IMAP / SMTP

Customers enter a public fully qualified server hostname. To limit server-side request forgery and port scanning, Lulu only accepts IMAP ports 143/993 and SMTP ports 25/465/587/2525. Recommend provider-issued app passwords instead of the primary account password.

## Deployment

The backend applies migration `0021_email_workspace.sql` automatically when `RUN_MIGRATIONS_ON_STARTUP=true`. After setting the OAuth values, rebuild and restart the backend. No provider secrets belong in the frontend build.

For production operations, monitor accounts whose status is `error` or `reauth_required`, sync jobs that fail repeatedly, provider rate limits and the AI usage ledger.
