import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { env } from '../src/config/env.js';
import { encryptSecret } from '../src/utils/secret-box.js';
import {
  normalizeCalcomBaseUrl,
  syncCalendarProvider,
} from '../src/modules/calendar/calendar.provider.service.js';
import { tokenConnectSchema } from '../src/modules/calendar/calendar.validator.js';
import { mergeCalendarEvents } from '../src/modules/calendar/calendar.merge.js';
import type { CalendarAccountCredential, CalendarEvent } from '../src/modules/calendar/calendar.types.js';
const previousCredentialKey=env.PROVIDER_CREDENTIAL_KEY;
before(()=>{env.PROVIDER_CREDENTIAL_KEY='71'.repeat(32);});
after(()=>{env.PROVIDER_CREDENTIAL_KEY=previousCredentialKey;});

function calendarEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  const now = new Date().toISOString();
  return {
    id: 'event-1',
    accountId: 'account-1',
    provider: 'google',
    providerEventId: 'provider-event-1',
    sourceId: null,
    sourceName: 'Primary',
    title: 'Customer meeting',
    description: null,
    startAt: '2026-09-01T10:00:00.000Z',
    endAt: '2026-09-01T11:00:00.000Z',
    timezone: 'Europe/Berlin',
    status: 'confirmed',
    location: null,
    meetingUrl: 'https://meet.google.com/abc-defg-hij?authuser=0',
    organizerName: null,
    organizerEmail: null,
    attendeeCount: 0,
    attendees: [],
    rawData: {},
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    accountEmail: 'owner@example.com',
    accountDisplayName: 'Work',
    ...overrides,
  };
}

describe('calendar integration safety', () => {
  it('merges the same appointment from multiple connected calendar sources', () => {
    const events = mergeCalendarEvents([
      calendarEvent({}),
      calendarEvent({
        id: 'event-2',
        accountId: 'account-2',
        provider: 'calendly',
        providerEventId: 'provider-event-2',
        sourceName: 'Calendly bookings',
        accountEmail: 'sales@example.com',
        accountDisplayName: 'Sales',
        meetingUrl: 'https://meet.google.com/abc-defg-hij?utm_source=calendly',
      }),
    ]);

    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.sources.map((source) => source.provider), ['google', 'calendly']);
  });

  it('keeps different appointments in the same time slot separate', () => {
    const events = mergeCalendarEvents([
      calendarEvent({ title: 'Customer meeting' }),
      calendarEvent({ id: 'event-2', accountId: 'account-2', providerEventId: 'provider-event-2', title: 'Internal review', meetingUrl: null }),
    ]);

    assert.equal(events.length, 2);
  });

  it('does not merge appointments with distinct meeting links', () => {
    const events = mergeCalendarEvents([
      calendarEvent({ title: 'Focus' }),
      calendarEvent({ id: 'event-2', accountId: 'account-2', providerEventId: 'provider-event-2', title: 'Focus', meetingUrl: 'https://meet.google.com/different-room' }),
    ]);

    assert.equal(events.length, 2);
  });

  it('normalizes the configured Cal.com API hostname', () => {
    assert.equal(normalizeCalcomBaseUrl(), 'https://api.cal.com');
    assert.equal(normalizeCalcomBaseUrl('https://API.CAL.COM/'), 'https://api.cal.com');
    assert.equal(tokenConnectSchema.parse({
      provider: 'calcom',
      apiKey: 'calendar-api-key',
      baseUrl: 'https://api.cal.com',
    }).provider, 'calcom');
  });

  it('rejects Cal.com URLs that could reach an untrusted service', () => {
    for (const value of [
      'http://api.cal.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://api.cal.com:8443',
      'https://user:password@api.cal.com',
      'https://api.cal.com?redirect=http://127.0.0.1',
    ]) {
      assert.throws(() => normalizeCalcomBaseUrl(value), /Cal\.com base URL/);
    }
  });

  it('follows bounded Google pagination without following HTTP redirects', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(init?.redirect, 'error');
      if (url.includes('/userinfo')) {
        return Response.json({ sub: 'google-user', email: 'owner@example.com', name: 'Owner' });
      }
      if (url.includes('/calendarList')) {
        return Response.json(url.includes('pageToken=calendar-next')
          ? { items: [] }
          : { items: [{ id: 'primary', summary: 'Primary' }], nextPageToken: 'calendar-next' });
      }
      if (url.includes('/events')) {
        const event = (id: string, day: string) => ({
          id,
          summary: id,
          start: { dateTime: `${day}T10:00:00Z` },
          end: { dateTime: `${day}T11:00:00Z` },
        });
        return Response.json(url.includes('pageToken=event-next')
          ? { items: [event('event-2', '2026-09-02')] }
          : { items: [event('event-1', '2026-09-01')], nextPageToken: 'event-next' });
      }
      return Response.json({}, { status: 404 });
    };

    const account: CalendarAccountCredential = {
      id: '0f7e4f08-a041-4aa5-bf32-b823295b7864',
      workspaceId: '261af75b-8666-4246-a97a-e95f5547553a',
      provider: 'google',
      externalAccountId: null,
      emailAddress: null,
      displayName: null,
      baseUrl: null,
      settings: {},
      status: 'connected',
      lastSyncAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      connectedBy: null,
      encryptedAccessToken: encryptSecret('google-access-token'),
      encryptedRefreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      encryptedApiKey: null,
    };

    try {
      const result = await syncCalendarProvider(account);
      assert.deepEqual(result.events.map((event) => event.providerEventId), ['event-1', 'event-2']);
      assert.ok(calls.some((url) => url.includes('pageToken=calendar-next')));
      assert.ok(calls.some((url) => url.includes('pageToken=event-next')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
