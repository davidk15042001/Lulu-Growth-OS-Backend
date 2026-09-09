import { AppError, notFoundError } from '../../utils/app-error.js';
import { encryptSecret } from '../../utils/secret-box.js';
import * as repo from './calendar.repo.js';
import { buildCalendarAuthorizationUrl } from './calendar.oauth.service.js';
import { inspectTokenConnection, syncCalendarProvider } from './calendar.provider.service.js';
import { mergeCalendarEvents } from './calendar.merge.js';
import type { CalendarProvider } from './calendar.types.js';
import type { ListEventsQuery } from './calendar.validator.js';
import type { CreateNativeEventInput } from './calendar.validator.js';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';

export const listAccounts = repo.listAccounts;
export const listEvents = repo.listEvents;
export const listNativeEvents = repo.listNativeEvents;

export async function createNativeEvent(workspaceId: string, userId: string, input: CreateNativeEventInput) {
  return repo.createNativeEvent(workspaceId, userId, input);
}

export async function deleteNativeEvent(workspaceId: string, eventId: string) {
  if (!(await repo.deleteNativeEvent(workspaceId, eventId))) throw notFoundError('Calendar event not found');
}

function agoraConfig() {
  if (!env.AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) throw new AppError(503, 'AGORA_NOT_CONFIGURED', 'Agora is not configured on the server');
  return { appId: env.AGORA_APP_ID, certificate: env.AGORA_APP_CERTIFICATE };
}

function buildAgoraToken(channelName: string, userAccount: string, expiresAt: number) {
  const config = agoraConfig();
  return RtcTokenBuilder.buildTokenWithUserAccount(config.appId, config.certificate, channelName, userAccount, RtcRole.PUBLISHER, expiresAt, expiresAt);
}

export async function createAgoraToken(workspaceId: string, eventId: string, userAccount: string) {
  const event = await repo.findNativeEvent(workspaceId, eventId);
  if (!event) throw notFoundError('Calendar event not found');
  const expiresAt = Math.max(Math.floor(new Date(event.endAt).getTime() / 1000) + 3600, Math.floor(Date.now() / 1000) + 900);
  const account = userAccount || randomUUID();
  return { appId: agoraConfig().appId, channelName: event.agoraChannelName, userAccount: account, token: buildAgoraToken(event.agoraChannelName, account, expiresAt), expiresAt: new Date(expiresAt * 1000).toISOString(), event };
}

export async function createGuestAgoraToken(token: string, guestName?: string) {
  const event = await repo.findNativeEventByGuestToken(token);
  if (!event) throw notFoundError('Calendar meeting not found or expired');
  const expiresAt = Math.max(Math.floor(new Date(event.endAt).getTime() / 1000) + 3600, Math.floor(Date.now() / 1000) + 900);
  const userAccount = (guestName?.trim() || `guest-${randomUUID()}`).slice(0, 64);
  return { appId: agoraConfig().appId, channelName: event.agoraChannelName, userAccount, token: buildAgoraToken(event.agoraChannelName, userAccount, expiresAt), expiresAt: new Date(expiresAt * 1000).toISOString(), event: { id: event.id, title: event.title, description: event.description, startAt: event.startAt, endAt: event.endAt, timezone: event.timezone, location: event.location } };
}

export function startOAuth(provider: Extract<CalendarProvider, 'google' | 'microsoft'>, workspaceId: string, userId: string, returnTo?: string) {
  return { provider, authorizationUrl: buildCalendarAuthorizationUrl(provider, workspaceId, userId, returnTo) };
}

export async function connectToken(workspaceId: string, userId: string, input: {
  provider: Extract<CalendarProvider, 'calendly' | 'calcom'>;
  apiKey: string;
  displayName?: string | undefined;
  baseUrl?: string | undefined;
}) {
  const identity = await inspectTokenConnection(input.provider, input.apiKey, input.baseUrl);
  return repo.upsertTokenAccount({
    workspaceId,
    userId,
    provider: input.provider,
    externalAccountId: identity.externalAccountId,
    emailAddress: identity.emailAddress,
    displayName: input.displayName?.trim() || identity.displayName,
    encryptedApiKey: encryptSecret(input.apiKey),
    baseUrl: input.baseUrl?.trim() || ('baseUrl' in identity ? identity.baseUrl ?? null : null),
    settings: identity.settings,
  });
}

export async function disconnect(workspaceId: string, accountId: string) {
  if (!(await repo.disconnectAccount(workspaceId, accountId))) throw notFoundError('Calendar account not found');
}

function errorDetails(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'CALENDAR_SYNC_FAILED', message: error instanceof Error ? error.message : 'Calendar synchronization failed' };
}

export async function startSync(workspaceId: string, accountId: string, userId: string | null) {
  const account = await repo.findAccount(workspaceId, accountId);
  if (!account) throw notFoundError('Calendar account not found');
  const job = await repo.createSyncJob(workspaceId, accountId, userId);
  if (!job) throw notFoundError('Calendar account not found');
  return job;
}

export async function getSyncJob(workspaceId: string, accountId: string, jobId: string) {
  const job = await repo.getSyncJob(workspaceId, accountId, jobId);
  if (!job) throw notFoundError('Calendar sync job not found');
  return job;
}

export async function executeSyncJob(workspaceId: string, accountId: string, jobId: string) {
  if (!(await repo.startSyncJob(jobId))) return;
  await repo.setAccountStatus(accountId, 'syncing');
  try {
    const account = await repo.findAccount(workspaceId, accountId);
    if (!account) throw notFoundError('Calendar account not found');
    const result = await syncCalendarProvider(account);
    await repo.updateAccountIdentity(account.id, result.account);
    await repo.saveProviderData(account.id, result.events);
    await repo.completeAccountSync(account.id);
    await repo.finishSyncJob(jobId, result.events.length);
  } catch (error) {
    const details = errorDetails(error);
    await repo.setAccountStatus(accountId, details.code === 'CALENDAR_PROVIDER_REAUTH_REQUIRED' ? 'reauth_required' : 'error', details.code, details.message);
    await repo.failSyncJob(jobId, details.code, details.message);
  }
}

export async function getOverview(workspaceId: string, filters: ListEventsQuery) {
  const [accounts, sourceEvents, nativeEvents] = await Promise.all([repo.listAccounts(workspaceId), repo.listEvents(workspaceId, filters), repo.listNativeEvents(workspaceId, filters)]);
  const events = mergeCalendarEvents(sourceEvents);
  const now = Date.now();
  const next7Days = now + 7 * 24 * 60 * 60 * 1000;
  return {
    accounts,
    events,
    nativeEvents,
    summary: {
      connectedAccounts: accounts.length,
      syncedAccounts: accounts.filter((account) => account.lastSyncAt).length,
      upcomingEvents: events.filter((event) => {
        const start = new Date(event.startAt).getTime();
        return start >= now && start <= next7Days;
      }).length,
      providers: Array.from(new Set(accounts.map((account) => account.provider))),
    },
  };
}
