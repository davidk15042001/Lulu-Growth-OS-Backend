import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { decryptSecret, encryptSecret } from '../../utils/secret-box.js';
import { AppError } from '../../utils/app-error.js';
import * as repo from './calendar.repo.js';
import { refreshCalendarOAuthToken } from './calendar.oauth.service.js';
import type { CalendarAccountCredential, CalendarAttendee, CalendarProvider, ProviderCalendarEvent, ProviderCalendarSyncResult } from './calendar.types.js';

const DEFAULT_CALCOM_BASE_URL = 'https://api.cal.com';
const SYNC_RANGE_PAST_DAYS = 30;
const SYNC_RANGE_FUTURE_DAYS = 120;
const MAX_PROVIDER_PAGES = 20;

function addDays(base: Date, days: number) {
  const value = new Date(base);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function syncRange() {
  const now = new Date();
  return {
    from: addDays(now, -SYNC_RANGE_PAST_DAYS).toISOString(),
    to: addDays(now, SYNC_RANGE_FUTURE_DAYS).toISOString(),
  };
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asArray<T = unknown>(value: unknown) {
  return Array.isArray(value) ? value as T[] : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ensureIso(value: string | null, fallback?: string | null) {
  if (value) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (fallback) {
    const date = new Date(fallback);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function defaultEnd(startAt: string) {
  return new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString();
}

function providerError(code: string, message: string, details?: Record<string, unknown>, status = 502) {
  return new AppError(status, code, message, details);
}

async function fetchJson(url: string, init: RequestInit, code: string, message: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw providerError(code, message, { providerNetworkError: true });
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw providerError(code, message, {
      providerHttpStatus: response.status,
      providerCode: stringValue(payload.error) ?? stringValue(asRecord(payload.error).code),
      providerMessage: stringValue(payload.error_description) ?? stringValue(payload.message) ?? stringValue(asRecord(payload.error).message),
    }, response.status === 401 ? 401 : 502);
  }
  return payload;
}

async function googleCollection(urlValue: string, token: string) {
  const url = new URL(urlValue);
  const items: unknown[] = [];
  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    const payload = await fetchJson(
      url.toString(),
      { headers: { authorization: `Bearer ${token}` } },
      'CALENDAR_PROVIDER_REQUEST_FAILED',
      'Google Calendar data could not be loaded',
    );
    items.push(...asArray(payload.items));
    const nextPageToken = stringValue(payload.nextPageToken);
    if (!nextPageToken) break;
    url.searchParams.set('pageToken', nextPageToken);
  }
  return items;
}

async function microsoftCollection(urlValue: string, token: string) {
  let nextUrl: string | null = urlValue;
  const items: unknown[] = [];
  for (let page = 0; nextUrl && page < MAX_PROVIDER_PAGES; page += 1) {
    const url = new URL(nextUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'graph.microsoft.com') {
      throw providerError('CALENDAR_PROVIDER_RESPONSE_INVALID', 'Microsoft returned an unsafe pagination URL');
    }
    const payload = await fetchJson(
      url.toString(),
      { headers: { authorization: `Bearer ${token}` } },
      'CALENDAR_PROVIDER_REQUEST_FAILED',
      'Microsoft Calendar data could not be loaded',
    );
    items.push(...asArray(payload.value));
    nextUrl = stringValue(payload['@odata.nextLink']);
  }
  return items;
}

async function calendlyCollection(urlValue: string, apiKey: string) {
  let nextUrl: string | null = urlValue;
  const items: unknown[] = [];
  for (let page = 0; nextUrl && page < MAX_PROVIDER_PAGES; page += 1) {
    const url = new URL(nextUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'api.calendly.com') {
      throw providerError('CALENDAR_PROVIDER_RESPONSE_INVALID', 'Calendly returned an unsafe pagination URL');
    }
    const payload = await fetchJson(
      url.toString(),
      { headers: { authorization: `Bearer ${apiKey}` } },
      'CALENDAR_PROVIDER_REQUEST_FAILED',
      'Calendly events could not be loaded',
    );
    items.push(...asArray(payload.collection));
    nextUrl = stringValue(asRecord(payload.pagination).next_page);
  }
  return items;
}

export function normalizeCalcomBaseUrl(baseUrl?: string | null) {
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || DEFAULT_CALCOM_BASE_URL);
  } catch {
    throw providerError('CALENDAR_CALCOM_BASE_URL_INVALID', 'Cal.com base URL is invalid', undefined, 422);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowedHosts = new Set(
    env.CALENDAR_CALCOM_ALLOWED_HOSTS
      .split(',')
      .map((value) => value.trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean),
  );
  if (
    url.protocol !== 'https:'
    || Boolean(url.username || url.password)
    || Boolean(url.search || url.hash)
    || Boolean(url.port && url.port !== '443')
    || !allowedHosts.has(hostname)
  ) {
    throw providerError(
      'CALENDAR_CALCOM_BASE_URL_NOT_ALLOWED',
      'Cal.com base URL must use an explicitly allowed HTTPS hostname',
      { allowedHosts: [...allowedHosts] },
      422,
    );
  }

  url.hostname = hostname;
  url.port = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

async function accessTokenFor(account: CalendarAccountCredential) {
  if (!account.encryptedAccessToken) throw providerError('CALENDAR_PROVIDER_REAUTH_REQUIRED', 'Calendar account must be reconnected before it can synchronize', undefined, 401);
  const expired = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() < Date.now() + 60_000 : false;
  if (!expired) return decryptSecret(account.encryptedAccessToken);
  if ((account.provider !== 'google' && account.provider !== 'microsoft') || !account.encryptedRefreshToken) {
    throw providerError('CALENDAR_PROVIDER_REAUTH_REQUIRED', 'Calendar account must be reconnected before it can synchronize', undefined, 401);
  }
  const token = await refreshCalendarOAuthToken(account.provider, decryptSecret(account.encryptedRefreshToken));
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw providerError('CALENDAR_OAUTH_ACCESS_TOKEN_MISSING', 'Calendar provider did not return a usable access token');
  const nextRefreshToken = stringValue(token.refresh_token);
  const expiresIn = Number(token.expires_in ?? 3600);
  await repo.updateOAuthTokens(
    account.id,
    encryptSecret(accessToken),
    nextRefreshToken ? encryptSecret(nextRefreshToken) : null,
    new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
  );
  return accessToken;
}

function normalizeAttendees(value: unknown): CalendarAttendee[] {
  return asArray(value).map((item) => {
    const record = asRecord(item);
    const emailAddress = stringValue(record.email)
      ?? stringValue(asRecord(record.emailAddress).address)
      ?? stringValue(asRecord(record.profile).email);
    return {
      name: stringValue(record.name) ?? stringValue(asRecord(record.emailAddress).name) ?? stringValue(asRecord(record.profile).name),
      email: emailAddress,
      status: stringValue(record.status) ?? stringValue(asRecord(record.responseStatus).response),
    };
  }).filter((item) => item.name || item.email);
}

function normalizeGoogleDate(node: unknown, timezone?: string | null) {
  const record = asRecord(node);
  const dateTime = stringValue(record.dateTime);
  if (dateTime) return { value: ensureIso(dateTime), timezone: stringValue(record.timeZone) ?? timezone ?? null };
  const date = stringValue(record.date);
  if (!date) return null;
  return { value: ensureIso(`${date}T00:00:00Z`), timezone: stringValue(record.timeZone) ?? timezone ?? null };
}

async function syncGoogle(account: CalendarAccountCredential): Promise<ProviderCalendarSyncResult> {
  const token = await accessTokenFor(account);
  const range = syncRange();
  const profile = await fetchJson(
    'https://openidconnect.googleapis.com/v1/userinfo',
    { headers: { authorization: `Bearer ${token}` } },
    'CALENDAR_ACCOUNT_LOOKUP_FAILED',
    'Connected Google Calendar identity could not be loaded',
  );
  const calendarList = await googleCollection(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50',
    token,
  );
  const calendars = calendarList.map(asRecord).slice(0, 12);
  const eventGroups = await Promise.all(calendars.map(async (calendar) => {
    const calendarId = stringValue(calendar.id);
    if (!calendarId) return [];
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('timeMin', range.from);
    url.searchParams.set('timeMax', range.to);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    const items = await googleCollection(url.toString(), token);
    return items.map((raw) => {
      const item = asRecord(raw);
      const start = normalizeGoogleDate(item.start, stringValue(calendar.timeZone));
      const end = normalizeGoogleDate(item.end, stringValue(calendar.timeZone));
      const startAt = start?.value ?? new Date().toISOString();
      const endAt = end?.value ?? defaultEnd(startAt);
      return {
        providerEventId: stringValue(item.id) ?? crypto.randomUUID?.() ?? `${calendarId}:${startAt}`,
        sourceId: calendarId,
        sourceName: stringValue(calendar.summary) ?? 'Google Calendar',
        title: stringValue(item.summary) ?? 'Untitled event',
        description: stringValue(item.description),
        startAt,
        endAt,
        timezone: start?.timezone ?? end?.timezone ?? null,
        status: stringValue(item.status) ?? 'confirmed',
        location: stringValue(item.location),
        meetingUrl: stringValue(item.hangoutLink) ?? stringValue(item.htmlLink),
        organizerName: stringValue(asRecord(item.organizer).displayName),
        organizerEmail: stringValue(asRecord(item.organizer).email),
        attendees: normalizeAttendees(item.attendees),
        rawData: item,
      } satisfies ProviderCalendarEvent;
    });
  }));
  return {
    account: {
      externalAccountId: stringValue(profile.sub),
      emailAddress: stringValue(profile.email),
      displayName: stringValue(profile.name),
      settings: { calendars: calendars.map((calendar) => ({ id: calendar.id, summary: calendar.summary, primary: calendar.primary })) },
    },
    events: eventGroups.flat(),
  };
}

async function syncMicrosoft(account: CalendarAccountCredential): Promise<ProviderCalendarSyncResult> {
  const token = await accessTokenFor(account);
  const range = syncRange();
  const identity = await fetchJson(
    'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
    { headers: { authorization: `Bearer ${token}` } },
    'CALENDAR_ACCOUNT_LOOKUP_FAILED',
    'Connected Microsoft Calendar identity could not be loaded',
  );
  const calendarItems = await microsoftCollection(
    'https://graph.microsoft.com/v1.0/me/calendars?$top=50&$select=id,name,isDefaultCalendar,color,owner',
    token,
  );
  const calendars = calendarItems.map(asRecord).slice(0, 12);
  const eventsByCalendar = await Promise.all(calendars.map(async (calendar) => {
    const calendarId = stringValue(calendar.id);
    if (!calendarId) return [];
    const url = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`);
    url.searchParams.set('startDateTime', range.from);
    url.searchParams.set('endDateTime', range.to);
    url.searchParams.set('$top', '200');
    url.searchParams.set('$select', 'id,subject,bodyPreview,start,end,location,organizer,attendees,onlineMeetingUrl,webLink,responseStatus,showAs');
    const items = await microsoftCollection(url.toString(), token);
    return items.map((raw) => {
      const item = asRecord(raw);
      const startRecord = asRecord(item.start);
      const endRecord = asRecord(item.end);
      const startAt = ensureIso(stringValue(startRecord.dateTime));
      const endAt = ensureIso(stringValue(endRecord.dateTime), defaultEnd(startAt));
      return {
        providerEventId: stringValue(item.id) ?? `${calendarId}:${startAt}`,
        sourceId: calendarId,
        sourceName: stringValue(calendar.name) ?? 'Microsoft Calendar',
        title: stringValue(item.subject) ?? 'Untitled event',
        description: stringValue(item.bodyPreview),
        startAt,
        endAt,
        timezone: stringValue(startRecord.timeZone) ?? stringValue(endRecord.timeZone),
        status: stringValue(item.showAs) ?? stringValue(asRecord(item.responseStatus).response) ?? 'confirmed',
        location: stringValue(asRecord(item.location).displayName),
        meetingUrl: stringValue(item.onlineMeetingUrl) ?? stringValue(item.webLink),
        organizerName: stringValue(asRecord(asRecord(item.organizer).emailAddress).name),
        organizerEmail: stringValue(asRecord(asRecord(item.organizer).emailAddress).address),
        attendees: normalizeAttendees(item.attendees),
        rawData: item,
      } satisfies ProviderCalendarEvent;
    });
  }));
  return {
    account: {
      externalAccountId: stringValue(identity.id),
      emailAddress: stringValue(identity.mail) ?? stringValue(identity.userPrincipalName),
      displayName: stringValue(identity.displayName),
      settings: { calendars: calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, isDefaultCalendar: calendar.isDefaultCalendar })) },
    },
    events: eventsByCalendar.flat(),
  };
}

async function inspectCalendly(apiKey: string) {
  const payload = await fetchJson(
    'https://api.calendly.com/users/me',
    { headers: { authorization: `Bearer ${apiKey}` } },
    'CALENDAR_PROVIDER_REQUEST_FAILED',
    'Calendly account could not be verified',
  );
  const resource = asRecord(payload.resource);
  return {
    externalAccountId: stringValue(resource.uri),
    emailAddress: stringValue(resource.email),
    displayName: stringValue(resource.name),
    settings: {
      userUri: stringValue(resource.uri),
      organizationUri: stringValue(resource.current_organization),
    },
  };
}

async function syncCalendly(account: CalendarAccountCredential): Promise<ProviderCalendarSyncResult> {
  if (!account.encryptedApiKey) throw providerError('CALENDAR_PROVIDER_REAUTH_REQUIRED', 'Calendly must be reconnected before it can synchronize', undefined, 401);
  const apiKey = decryptSecret(account.encryptedApiKey);
  const identity = await inspectCalendly(apiKey);
  const range = syncRange();
  const url = new URL('https://api.calendly.com/scheduled_events');
  if (stringValue(identity.settings.organizationUri)) url.searchParams.set('organization', String(identity.settings.organizationUri));
  else if (stringValue(identity.settings.userUri)) url.searchParams.set('user', String(identity.settings.userUri));
  url.searchParams.set('min_start_time', range.from);
  url.searchParams.set('max_start_time', range.to);
  url.searchParams.set('status', 'active');
  url.searchParams.set('count', '100');
  const collection = await calendlyCollection(url.toString(), apiKey);
  const events = collection.map((raw) => {
    const item = asRecord(raw);
    const location = asRecord(item.location);
    const startAt = ensureIso(stringValue(item.start_time));
    const endAt = ensureIso(stringValue(item.end_time), defaultEnd(startAt));
    return {
      providerEventId: stringValue(item.uri) ?? stringValue(item.id) ?? startAt,
      sourceId: stringValue(asRecord(item.event_type).slug) ?? stringValue(asRecord(item.event_type).name),
      sourceName: stringValue(asRecord(item.event_type).name) ?? 'Calendly',
      title: stringValue(item.name) ?? 'Calendly event',
      description: stringValue(item.event_memberships?.toString?.()),
      startAt,
      endAt,
      timezone: stringValue(item.start_time) ? 'UTC' : null,
      status: stringValue(item.status) ?? 'active',
      location: stringValue(location.location) ?? stringValue(location.type),
      meetingUrl: stringValue(location.join_url),
      organizerName: identity.displayName,
      organizerEmail: identity.emailAddress,
      attendees: [],
      rawData: item,
    } satisfies ProviderCalendarEvent;
  });
  return { account: identity, events };
}

async function inspectCalcom(apiKey: string, baseUrl?: string | null) {
  const root = normalizeCalcomBaseUrl(baseUrl);
  const payload = await fetchJson(
    `${root}/v1/me?apiKey=${encodeURIComponent(apiKey)}`,
    { headers: { accept: 'application/json' } },
    'CALENDAR_PROVIDER_REQUEST_FAILED',
    'Cal.com account could not be verified',
  );
  const data = asRecord(payload.data);
  const user = asRecord(data.user);
  return {
    externalAccountId: stringValue(user.id) ?? stringValue(data.id),
    emailAddress: stringValue(user.email) ?? stringValue(data.email),
    displayName: stringValue(user.name) ?? stringValue(data.name) ?? stringValue(user.username),
    baseUrl: root,
    settings: {
      username: stringValue(user.username),
      timeZone: stringValue(user.timeZone),
    },
  };
}

async function syncCalcom(account: CalendarAccountCredential): Promise<ProviderCalendarSyncResult> {
  if (!account.encryptedApiKey) throw providerError('CALENDAR_PROVIDER_REAUTH_REQUIRED', 'Cal.com must be reconnected before it can synchronize', undefined, 401);
  const apiKey = decryptSecret(account.encryptedApiKey);
  const identity = await inspectCalcom(apiKey, account.baseUrl);
  const range = syncRange();
  const url = new URL(`${identity.baseUrl}/v1/bookings`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('status', 'upcoming');
  const payload = await fetchJson(
    url.toString(),
    { headers: { accept: 'application/json' } },
    'CALENDAR_PROVIDER_REQUEST_FAILED',
    'Cal.com bookings could not be loaded',
  );
  const rawBookings = asArray(asRecord(payload.data).bookings).length ? asArray(asRecord(payload.data).bookings) : asArray(payload.bookings);
  const fromTime = new Date(range.from).getTime();
  const toTime = new Date(range.to).getTime();
  const events = rawBookings.map((raw) => {
    const item = asRecord(raw);
    const startAt = ensureIso(stringValue(item.startTime) ?? stringValue(item.start));
    const endAt = ensureIso(stringValue(item.endTime) ?? stringValue(item.end), defaultEnd(startAt));
    const meetingUrl = stringValue(item.meetingUrl) ?? stringValue(item.videoCallUrl) ?? stringValue(asRecord(item.location).link);
    return {
      providerEventId: String(item.id ?? item.uid ?? startAt),
      sourceId: stringValue(asRecord(item.eventType).slug) ?? stringValue(item.eventTypeId),
      sourceName: stringValue(asRecord(item.eventType).title) ?? stringValue(item.title) ?? 'Cal.com booking',
      title: stringValue(item.title) ?? stringValue(asRecord(item.eventType).title) ?? 'Cal.com booking',
      description: stringValue(item.description),
      startAt,
      endAt,
      timezone: stringValue(item.timeZone) ?? stringValue(asRecord(item.user).timeZone),
      status: stringValue(item.status) ?? 'upcoming',
      location: stringValue(item.location) ?? stringValue(asRecord(item.metadata).location),
      meetingUrl,
      organizerName: stringValue(asRecord(item.user).name) ?? identity.displayName,
      organizerEmail: stringValue(asRecord(item.user).email) ?? identity.emailAddress,
      attendees: normalizeAttendees(item.attendees),
      rawData: item,
    } satisfies ProviderCalendarEvent;
  }).filter((item) => {
    const start = new Date(item.startAt).getTime();
    return Number.isFinite(start) && start >= fromTime && start <= toTime;
  });
  return {
    account: {
      externalAccountId: identity.externalAccountId,
      emailAddress: identity.emailAddress,
      displayName: identity.displayName,
      settings: identity.settings,
    },
    events,
  };
}

export async function inspectTokenConnection(provider: Extract<CalendarProvider, 'calendly' | 'calcom'>, apiKey: string, baseUrl?: string | null) {
  return provider === 'calendly' ? inspectCalendly(apiKey) : inspectCalcom(apiKey, baseUrl);
}

export async function syncCalendarProvider(account: CalendarAccountCredential) {
  switch (account.provider) {
    case 'google':
      return syncGoogle(account);
    case 'microsoft':
      return syncMicrosoft(account);
    case 'calendly':
      return syncCalendly(account);
    case 'calcom':
      return syncCalcom(account);
  }
}
