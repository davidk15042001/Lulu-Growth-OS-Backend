import type { CalendarEvent, CalendarEventSource, UnifiedCalendarEvent } from './calendar.types.js';

function normalizedText(value?: string | null) {
  return value?.trim().toLocaleLowerCase().replace(/\s+/g, ' ') || '';
}

function canonicalMeetingUrl(value?: string | null) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/$/, '') || '/';
    return `${url.protocol}//${url.hostname.toLocaleLowerCase()}${url.port ? `:${url.port}` : ''}${path}`;
  } catch {
    return normalizedText(value);
  }
}

function eventKeys(event: CalendarEvent) {
  const slot = `${new Date(event.startAt).toISOString()}|${new Date(event.endAt).toISOString()}`;
  const meetingUrl = canonicalMeetingUrl(event.meetingUrl);
  return meetingUrl
    ? [`meeting:${slot}|${meetingUrl}`]
    : [`slot:${slot}|${normalizedText(event.title)}`];
}

function eventSource(event: CalendarEvent): CalendarEventSource {
  return {
    accountId: event.accountId,
    provider: event.provider,
    sourceName: event.sourceName,
    accountEmail: event.accountEmail,
    accountDisplayName: event.accountDisplayName,
  };
}

export function mergeCalendarEvents(events: CalendarEvent[]): UnifiedCalendarEvent[] {
  const merged: UnifiedCalendarEvent[] = [];
  const indexByKey = new Map<string, number>();

  for (const event of events) {
    const keys = eventKeys(event);
    const existingIndex = keys.map((key) => indexByKey.get(key)).find((index) => index !== undefined);

    if (existingIndex === undefined) {
      const index = merged.push({ ...event, sources: [eventSource(event)] }) - 1;
      keys.forEach((key) => indexByKey.set(key, index));
      continue;
    }

    const existing = merged[existingIndex]!;
    if (!existing.sources.some((source) => source.accountId === event.accountId)) {
      existing.sources.push(eventSource(event));
    }
    keys.forEach((key) => indexByKey.set(key, existingIndex));
  }

  return merged;
}
