import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encryptSecret } from '../src/utils/secret-box.js';
import {
  normalizeCalcomBaseUrl,
  syncCalendarProvider,
} from '../src/modules/calendar/calendar.provider.service.js';
import { tokenConnectSchema } from '../src/modules/calendar/calendar.validator.js';
import type { CalendarAccountCredential } from '../src/modules/calendar/calendar.types.js';

describe('calendar integration safety', () => {
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
