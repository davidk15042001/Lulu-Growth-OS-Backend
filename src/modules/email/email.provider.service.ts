import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import PostalMime, { type Address } from 'postal-mime';
import { AppError } from '../../utils/app-error.js';
import { decryptSecret, encryptSecret } from '../../utils/secret-box.js';
import { env } from '../../config/env.js';
import * as repo from './email.repo.js';
import { refreshEmailOAuthToken } from './email.oauth.service.js';
import type { EmailAccountCredential, EmailAddress, ProviderFolder, ProviderMessage, ProviderSyncResult, SendEmailInput } from './email.types.js';

function providerError(code: string, message: string, details?: Record<string, unknown>, status = 502) {
  return new AppError(status, code, message, details);
}

export function isPublicMailAddress(address: string) {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (normalized.startsWith('::ffff:')) return isPublicMailAddress(normalized.slice(7));
  const version = isIP(normalized);
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0 || b === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    if (normalized === '::' || normalized === '::1') return false;
    if (/^(fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

async function assertPublicMailHosts(hosts: Array<string | null>) {
  for (const host of [...new Set(hosts.filter((value): value is string => Boolean(value)))]) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => !isPublicMailAddress(item.address))) {
      throw providerError('EMAIL_IMAP_CONFIGURATION_INVALID', 'Mail server hostname resolves to a non-public address', undefined, 422);
    }
  }
}

async function providerFetch(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(30_000) });
  if (response.status === 204 || response.status === 202) return { response, payload: null };
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw providerError(response.status === 401 ? 'EMAIL_PROVIDER_REAUTH_REQUIRED' : 'EMAIL_PROVIDER_REQUEST_FAILED', 'Email provider rejected the request', { providerHttpStatus: response.status, providerCode: (payload.error as Record<string, unknown> | undefined)?.code ?? payload.error, providerMessage: (payload.error as Record<string, unknown> | undefined)?.message });
  return { response, payload };
}

export async function accessToken(account: EmailAccountCredential) {
  if (account.provider === 'imap') throw providerError('EMAIL_PROVIDER_INVALID', 'IMAP account does not use OAuth');
  if (!account.encryptedAccessToken) throw providerError('EMAIL_PROVIDER_REAUTH_REQUIRED', 'Email connection has no access token', undefined, 409);
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60_000) return decryptSecret(account.encryptedAccessToken);
  if (!account.encryptedRefreshToken) throw providerError('EMAIL_PROVIDER_REAUTH_REQUIRED', 'Email connection must be reauthorized', undefined, 409);
  const refreshToken = decryptSecret(account.encryptedRefreshToken);
  const token = await refreshEmailOAuthToken(account.provider, refreshToken);
  const nextAccess = typeof token.access_token === 'string' ? token.access_token : '';
  if (!nextAccess) throw providerError('EMAIL_OAUTH_ACCESS_TOKEN_MISSING', 'Email provider did not return a refreshed access token');
  const nextRefresh = typeof token.refresh_token === 'string' ? token.refresh_token : null;
  const expires = new Date(Date.now() + Math.max(60, Number(token.expires_in ?? 3600)) * 1000).toISOString();
  await repo.updateOAuthTokens(account.id, encryptSecret(nextAccess), nextRefresh ? encryptSecret(nextRefresh) : null, expires);
  return nextAccess;
}

function base64UrlDecode(value?: string | null) {
  if (!value) return '';
  try { return Buffer.from(value, 'base64url').toString('utf8'); } catch { return ''; }
}

function gmailHeaders(payload: Record<string, unknown>) {
  const values = Array.isArray(payload.headers) ? payload.headers as Array<Record<string, unknown>> : [];
  const result = new Map<string, string>();
  for (const item of values) result.set(String(item.name ?? '').toLowerCase(), String(item.value ?? ''));
  return result;
}

function gmailBody(part: Record<string, unknown>, mimeType: string): string {
  if (String(part.mimeType ?? '') === mimeType) return base64UrlDecode((part.body as Record<string, unknown> | undefined)?.data as string | undefined);
  const parts = Array.isArray(part.parts) ? part.parts as Array<Record<string, unknown>> : [];
  for (const child of parts) { const found = gmailBody(child, mimeType); if (found) return found; }
  return '';
}

function parseAddresses(value?: string | null): EmailAddress[] {
  if (!value) return [];
  return value.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).flatMap((part) => {
    const match = part.trim().match(/^(?:\"?([^\"<]*)\"?\s*)?<([^>]+)>$/);
    const address = (match?.[2] ?? part).trim().toLowerCase();
    if (!address.includes('@')) return [];
    return [{ address, name: match?.[1]?.trim() || null }];
  });
}

async function syncGoogle(account: EmailAccountCredential, token: string): Promise<ProviderSyncResult> {
  const [{ payload: labelPayload }, { payload: listPayload }] = await Promise.all([
    providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', token),
    providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${env.EMAIL_SYNC_MESSAGE_LIMIT}`, token),
  ]);
  const labelRefs = Array.isArray(labelPayload?.labels) ? labelPayload.labels as Array<Record<string, unknown>> : [];
  const labels: Array<Record<string, unknown>> = [];
  for (let index = 0; index < labelRefs.length; index += 10) {
    const batch = await Promise.all(labelRefs.slice(index, index + 10).map((label) => providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(String(label.id))}`, token).then((result) => result.payload ?? label)));
    labels.push(...batch);
  }
  const folders: ProviderFolder[] = labels.map((label) => ({
    providerFolderId: String(label.id), name: String(label.name ?? label.id),
    systemName: gmailSystemName(String(label.id)), unreadCount: Number(label.messagesUnread ?? 0), totalCount: Number(label.messagesTotal ?? 0),
  }));
  const refs = Array.isArray(listPayload?.messages) ? listPayload.messages as Array<Record<string, unknown>> : [];
  const messages: ProviderMessage[] = [];
  for (let index = 0; index < refs.length; index += 10) {
    const batch = await Promise.all(refs.slice(index, index + 10).map((ref) => providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(String(ref.id))}?format=full`, token).then((result) => result.payload)));
    for (const item of batch) {
      if (!item) continue;
      const payload = (item.payload ?? {}) as Record<string, unknown>;
      const headers = gmailHeaders(payload);
      const labelIds = Array.isArray(item.labelIds) ? item.labelIds.map(String) : [];
      const sender = parseAddresses(headers.get('from'))[0] ?? { address: '' };
      const recipients = parseAddresses(headers.get('to'));
      const textBody = gmailBody(payload, 'text/plain') || stripHtml(gmailBody(payload, 'text/html'));
      const internalDate = new Date(Number(item.internalDate ?? Date.now())).toISOString();
      messages.push({
        providerMessageId: String(item.id), providerThreadId: String(item.threadId ?? item.id), internetMessageId: headers.get('message-id') ?? null,
        direction: labelIds.includes('SENT') || sender.address === account.emailAddress.toLowerCase() ? 'outbound' : 'inbound',
        sender, recipients, ccRecipients: parseAddresses(headers.get('cc')), subject: headers.get('subject') || '(No subject)',
        preview: String(item.snippet ?? '').slice(0, 500), textBody: textBody.slice(0, 100_000), htmlBody: null,
        providerFolderIds: labelIds, receivedAt: internalDate, sentAt: labelIds.includes('SENT') ? internalDate : null,
        isRead: !labelIds.includes('UNREAD'), starred: labelIds.includes('STARRED'),
      });
    }
  }
  return { folders, messages, cursor: String(listPayload?.resultSizeEstimate ?? '') || null };
}

function gmailSystemName(id: string) {
  return ({ INBOX: 'inbox', SENT: 'sent', DRAFT: 'drafts', TRASH: 'trash', SPAM: 'spam', STARRED: 'starred', IMPORTANT: 'important' } as Record<string, string>)[id] ?? null;
}

function graphAddress(value: unknown): EmailAddress {
  const email = ((value as Record<string, unknown> | undefined)?.emailAddress ?? {}) as Record<string, unknown>;
  return { address: String(email.address ?? '').toLowerCase(), name: String(email.name ?? '') || null };
}

async function graphCollection(url: string, token: string, limit = 250) {
  const values: Array<Record<string, unknown>> = [];
  let nextUrl: string | null = url;
  while (nextUrl && values.length < limit) {
    const { payload } = await providerFetch(nextUrl, token);
    const page = Array.isArray(payload?.value) ? payload.value as Array<Record<string, unknown>> : [];
    values.push(...page.slice(0, limit - values.length));
    nextUrl = typeof payload?.['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null;
  }
  return values;
}

async function microsoftFolders(token: string) {
  const select = '$select=id,displayName,parentFolderId,unreadItemCount,totalItemCount';
  const root = await graphCollection(`https://graph.microsoft.com/v1.0/me/mailFolders?includeHiddenFolders=false&$top=100&${select}`, token);
  const folders = new Map(root.map((folder) => [String(folder.id), folder]));
  let pending = [...root];
  while (pending.length && folders.size < 250) {
    const level = pending.splice(0, 8);
    const children = (await Promise.all(level.map((folder) => graphCollection(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(String(folder.id))}/childFolders?includeHiddenFolders=false&$top=100&${select}`, token, 250 - folders.size)))).flat();
    for (const child of children) {
      const id = String(child.id);
      if (!id || folders.has(id)) continue;
      folders.set(id, child);
      pending.push(child);
      if (folders.size >= 250) break;
    }
  }

  const wellKnownIds = new Map<string, string>();
  const knownNames = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail'] as const;
  const knownFolders = await Promise.all(knownNames.map((name) => providerFetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${name}?${select}`, token).then(({ payload }) => ({ name, payload }))));
  for (const item of knownFolders) if (item.payload?.id) wellKnownIds.set(String(item.payload.id), item.name);
  return { folders: [...folders.values()], wellKnownIds };
}

async function syncMicrosoft(account: EmailAccountCredential, token: string): Promise<ProviderSyncResult> {
  const messageUrl = `https://graph.microsoft.com/v1.0/me/messages?$top=${env.EMAIL_SYNC_MESSAGE_LIMIT}&$orderby=receivedDateTime%20desc&$select=id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag,parentFolderId`;
  const [{ folders: rawFolders, wellKnownIds }, { payload: messagePayload }] = await Promise.all([microsoftFolders(token), providerFetch(messageUrl, token)]);
  const folders: ProviderFolder[] = rawFolders.map((folder) => ({ providerFolderId: String(folder.id), parentProviderFolderId: String(folder.parentFolderId ?? '') || null, name: String(folder.displayName ?? 'Folder'), systemName: microsoftSystemName(String(folder.displayName ?? ''), wellKnownIds.get(String(folder.id)) ?? ''), unreadCount: Number(folder.unreadItemCount ?? 0), totalCount: Number(folder.totalItemCount ?? 0) }));
  const sentFolderIds = new Set(folders.filter((folder) => folder.systemName === 'sent').map((folder) => folder.providerFolderId));
  const rawMessages = Array.isArray(messagePayload?.value) ? messagePayload.value as Array<Record<string, unknown>> : [];
  const messages: ProviderMessage[] = rawMessages.map((message) => {
    const sender = graphAddress(message.from);
    const folderId = String(message.parentFolderId ?? '');
    const sent = sentFolderIds.has(folderId) || sender.address === account.emailAddress.toLowerCase();
    return {
      providerMessageId: String(message.id), providerThreadId: String(message.conversationId ?? message.id), internetMessageId: String(message.internetMessageId ?? '') || null,
      direction: sent ? 'outbound' : 'inbound', sender,
      recipients: Array.isArray(message.toRecipients) ? message.toRecipients.map(graphAddress).filter((value) => value.address) : [],
      ccRecipients: Array.isArray(message.ccRecipients) ? message.ccRecipients.map(graphAddress).filter((value) => value.address) : [],
      subject: String(message.subject ?? '(No subject)'), preview: String(message.bodyPreview ?? '').slice(0, 500),
      textBody: stripHtml(String((message.body as Record<string, unknown> | undefined)?.content ?? '')).slice(0, 100_000), htmlBody: null,
      providerFolderIds: folderId ? [folderId] : [], receivedAt: String(message.receivedDateTime ?? '') || null, sentAt: sent ? String(message.sentDateTime ?? '') || null : null,
      isRead: Boolean(message.isRead), starred: String((message.flag as Record<string, unknown> | undefined)?.flagStatus ?? '') === 'flagged',
    };
  });
  return { folders, messages };
}

function microsoftSystemName(name: string, wellKnown: string) {
  const normalized = (wellKnown || name).toLowerCase().replace(/\s/g, '');
  if (normalized.includes('inbox')) return 'inbox';
  if (normalized.includes('sent')) return 'sent';
  if (normalized.includes('draft')) return 'drafts';
  if (normalized.includes('deleted') || normalized.includes('trash')) return 'trash';
  if (normalized.includes('junk')) return 'spam';
  return null;
}

function imapCredentials(account: EmailAccountCredential) {
  if (!account.encryptedPassword || !account.imapHost || !account.imapPort) throw providerError('EMAIL_IMAP_CONFIGURATION_INVALID', 'IMAP account configuration is incomplete', undefined, 409);
  return { host: account.imapHost, port: account.imapPort, secure: account.imapSecure, auth: { user: account.emailAddress, pass: decryptSecret(account.encryptedPassword) }, logger: false as const };
}

function postalAddresses(value?: Address | Address[] | null): EmailAddress[] {
  const values = value ? (Array.isArray(value) ? value : [value]) : [];
  return values.flatMap((item) => Array.isArray(item.group) ? item.group : item.address ? [item] : []).map((item) => ({ address: item.address.toLowerCase(), name: item.name || null })).filter((item) => item.address);
}

function imapMessageId(path: string, uid: number) { return `${Buffer.from(path).toString('base64url')}.${uid}`; }
function parseImapMessageId(value: string) { const index = value.lastIndexOf('.'); return { path: Buffer.from(value.slice(0, index), 'base64url').toString('utf8'), uid: Number(value.slice(index + 1)) }; }

function dateIso(value: string | Date | undefined | null) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function mailAddresses(values: EmailAddress[]) {
  return values.map((value) => ({ address: value.address, ...(value.name ? { name: value.name } : {}) }));
}

function sendMailAsync(transport: nodemailer.Transporter, options: SendMailOptions) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    transport.sendMail(options, (error, info) => error ? reject(error) : resolve(info as Record<string, unknown>));
  });
}

async function syncImap(account: EmailAccountCredential): Promise<ProviderSyncResult> {
  await assertPublicMailHosts([account.imapHost]);
  const client = new ImapFlow(imapCredentials(account));
  await client.connect();
  try {
    const mailboxes = (await client.list()).filter((mailbox) => !mailbox.flags.has('\\Noselect')).slice(0, 30);
    const folders: ProviderFolder[] = mailboxes.map((mailbox) => {
      const separator = mailbox.delimiter || '/';
      const parentPath = mailbox.path.includes(separator) ? mailbox.path.slice(0, mailbox.path.lastIndexOf(separator)) : null;
      return { providerFolderId: mailbox.path, parentProviderFolderId: parentPath, name: mailbox.name, systemName: mailbox.specialUse ? imapSystemName(mailbox.specialUse) : imapSystemName(mailbox.name), unreadCount: 0, totalCount: 0 };
    });
    for (const mailbox of mailboxes) {
      const status = await client.status(mailbox.path, { messages: true, unseen: true });
      const folder = folders.find((item) => item.providerFolderId === mailbox.path);
      if (folder) { folder.totalCount = status.messages ?? 0; folder.unreadCount = status.unseen ?? 0; }
    }
    const priority = (mailbox: typeof mailboxes[number]) => {
      const systemName = mailbox.specialUse ? imapSystemName(mailbox.specialUse) : imapSystemName(mailbox.name);
      return systemName === 'inbox' ? 0 : systemName === 'sent' ? 1 : systemName === 'drafts' ? 2 : 3;
    };
    const selected = [...mailboxes].sort((left, right) => priority(left) - priority(right)).slice(0, Math.min(20, Math.max(1, env.EMAIL_SYNC_MESSAGE_LIMIT)));
    const messages: ProviderMessage[] = [];
    const perFolder = Math.max(1, Math.floor(env.EMAIL_SYNC_MESSAGE_LIMIT / Math.max(1, selected.length)));
    for (const mailbox of selected) {
      const lock = await client.getMailboxLock(mailbox.path);
      try {
        const exists = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0;
        if (!exists) continue;
        const start = Math.max(1, exists - perFolder + 1);
        for await (const item of client.fetch(`${start}:*`, { uid: true, source: true, flags: true, internalDate: true })) {
          if (!item.source) continue;
          const parsed = await PostalMime.parse(item.source, { maxHeadersSize: 256 * 1024, maxNestingDepth: 30, maxRfc822NestingDepth: 3 });
          const sender = postalAddresses(parsed.from)[0] ?? { address: '' };
          const recipients = postalAddresses(parsed.to);
          const messageId = parsed.messageId ?? imapMessageId(mailbox.path, item.uid);
          const reference = parsed.references?.split(/\s+/).find(Boolean);
          const threadKey = reference ?? parsed.inReplyTo ?? crypto.createHash('sha256').update(`${(parsed.subject ?? '').replace(/^re:\s*/i, '').toLowerCase()}|${[sender.address, ...recipients.map((v) => v.address)].sort().join(',')}`).digest('hex');
          const sent = imapSystemName(mailbox.specialUse ?? mailbox.name) === 'sent' || sender.address === account.emailAddress.toLowerCase();
          const flags = item.flags ?? new Set<string>();
          messages.push({ providerMessageId: imapMessageId(mailbox.path, item.uid), providerThreadId: String(threadKey), internetMessageId: messageId, direction: sent ? 'outbound' : 'inbound', sender, recipients, ccRecipients: postalAddresses(parsed.cc), subject: parsed.subject || '(No subject)', preview: (parsed.text ?? '').replace(/\s+/g, ' ').slice(0, 500), textBody: (parsed.text ?? stripHtml(parsed.html || '')).slice(0, 100_000), htmlBody: null, providerFolderIds: [mailbox.path], receivedAt: dateIso(parsed.date ?? item.internalDate), sentAt: sent ? dateIso(parsed.date ?? item.internalDate) : null, isRead: flags.has('\\Seen'), starred: flags.has('\\Flagged') });
        }
      } finally { lock.release(); }
    }
    return { folders, messages };
  } finally { await client.logout().catch(() => undefined); }
}

function imapSystemName(value: string) {
  const normalized = value.toLowerCase().replace(/[\\\s_-]/g, '');
  if (normalized.includes('inbox')) return 'inbox'; if (normalized.includes('sent')) return 'sent'; if (normalized.includes('draft')) return 'drafts'; if (normalized.includes('trash') || normalized.includes('deleted')) return 'trash'; if (normalized.includes('junk') || normalized.includes('spam')) return 'spam'; return null;
}

function stripHtml(value: string) { return value.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim(); }

export async function syncProvider(account: EmailAccountCredential) {
  if (account.provider === 'imap') return syncImap(account);
  const token = await accessToken(account);
  return account.provider === 'google' ? syncGoogle(account, token) : syncMicrosoft(account, token);
}

export async function setProviderMessageState(account: EmailAccountCredential, providerMessageId: string, state: { isRead?: boolean; starred?: boolean }) {
  if (account.provider === 'google') {
    const token = await accessToken(account); const addLabelIds: string[] = []; const removeLabelIds: string[] = [];
    if (state.isRead !== undefined) (state.isRead ? removeLabelIds : addLabelIds).push('UNREAD');
    if (state.starred !== undefined) (state.starred ? addLabelIds : removeLabelIds).push('STARRED');
    await providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(providerMessageId)}/modify`, token, { method: 'POST', body: JSON.stringify({ addLabelIds, removeLabelIds }) });
    return;
  }
  if (account.provider === 'microsoft') {
    const token = await accessToken(account); const body: Record<string, unknown> = {};
    if (state.isRead !== undefined) body.isRead = state.isRead;
    if (state.starred !== undefined) body.flag = { flagStatus: state.starred ? 'flagged' : 'notFlagged' };
    await providerFetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(providerMessageId)}`, token, { method: 'PATCH', body: JSON.stringify(body) });
    return;
  }
  await assertPublicMailHosts([account.imapHost]);
  const parsed = parseImapMessageId(providerMessageId); const client = new ImapFlow(imapCredentials(account)); await client.connect();
  try { const lock = await client.getMailboxLock(parsed.path); try {
    if (state.isRead !== undefined) await (state.isRead ? client.messageFlagsAdd(parsed.uid, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(parsed.uid, ['\\Seen'], { uid: true }));
    if (state.starred !== undefined) await (state.starred ? client.messageFlagsAdd(parsed.uid, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(parsed.uid, ['\\Flagged'], { uid: true }));
  } finally { lock.release(); } } finally { await client.logout().catch(() => undefined); }
}

export async function sendProviderEmail(account: EmailAccountCredential, input: SendEmailInput) {
  if (account.provider === 'microsoft') {
    const token = await accessToken(account);
    if (input.replyToProviderMessageId) {
      await providerFetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.replyToProviderMessageId)}/reply`, token, { method: 'POST', body: JSON.stringify({ comment: input.bodyText }) });
      return { providerMessageId: null };
    }
    await providerFetch('https://graph.microsoft.com/v1.0/me/sendMail', token, { method: 'POST', body: JSON.stringify({ message: { subject: input.subject, body: { contentType: 'Text', content: input.bodyText }, toRecipients: input.to.map((item) => ({ emailAddress: item })), ccRecipients: input.cc.map((item) => ({ emailAddress: item })) }, saveToSentItems: true }) });
    return { providerMessageId: null };
  }
  if (account.provider === 'google') {
    const token = await accessToken(account);
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    const built = await sendMailAsync(transport, { from: { address: account.emailAddress, name: account.displayName ?? account.emailAddress }, to: mailAddresses(input.to), cc: mailAddresses(input.cc), subject: input.subject, text: input.bodyText, ...(input.internetMessageId ? { inReplyTo: input.internetMessageId, references: input.internetMessageId } : {}) });
    const builtMessage = built.message;
    const raw = Buffer.isBuffer(builtMessage) ? builtMessage.toString('base64url') : Buffer.from(String(builtMessage ?? '')).toString('base64url');
    const { payload } = await providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, { method: 'POST', body: JSON.stringify({ raw, ...(input.providerThreadId ? { threadId: input.providerThreadId } : {}) }) });
    return { providerMessageId: String(payload?.id ?? '') || null };
  }
  if (!account.encryptedPassword || !account.smtpHost || !account.smtpPort) throw providerError('EMAIL_SMTP_CONFIGURATION_INVALID', 'SMTP account configuration is incomplete', undefined, 409);
  await assertPublicMailHosts([account.smtpHost]);
  const transport = nodemailer.createTransport({ host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure, auth: { user: account.emailAddress, pass: decryptSecret(account.encryptedPassword) }, connectionTimeout: 20_000, socketTimeout: 30_000 });
  const info = await sendMailAsync(transport, { from: { address: account.emailAddress, name: account.displayName ?? account.emailAddress }, to: mailAddresses(input.to), cc: mailAddresses(input.cc), subject: input.subject, text: input.bodyText, ...(input.internetMessageId ? { inReplyTo: input.internetMessageId, references: input.internetMessageId } : {}) });
  return { providerMessageId: typeof info.messageId === 'string' ? info.messageId : null };
}

export async function verifyImapConnection(account: EmailAccountCredential) {
  await assertPublicMailHosts([account.imapHost, account.smtpHost]);
  const client = new ImapFlow(imapCredentials(account));
  await client.connect();
  try { await client.list(); } finally { await client.logout().catch(() => undefined); }
  if (!account.encryptedPassword || !account.smtpHost || !account.smtpPort) throw providerError('EMAIL_SMTP_CONFIGURATION_INVALID', 'SMTP configuration is incomplete');
  const smtp = nodemailer.createTransport({ host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure, auth: { user: account.emailAddress, pass: decryptSecret(account.encryptedPassword) }, connectionTimeout: 20_000 });
  await smtp.verify();
}
