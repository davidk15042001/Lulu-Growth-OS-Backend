export type CalendarProvider = 'google' | 'microsoft' | 'calendly' | 'calcom';

export type CalendarAttendee = {
  name?: string | null;
  email?: string | null;
  status?: string | null;
};

export type CalendarAccount = {
  id: string;
  workspaceId: string;
  provider: CalendarProvider;
  externalAccountId: string | null;
  emailAddress: string | null;
  displayName: string | null;
  baseUrl: string | null;
  settings: Record<string, unknown>;
  status: string;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CalendarAccountCredential = CalendarAccount & {
  connectedBy: string | null;
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: string | null;
  encryptedApiKey: string | null;
};

export type CalendarEvent = {
  id: string;
  accountId: string;
  provider: CalendarProvider;
  providerEventId: string;
  sourceId: string | null;
  sourceName: string | null;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string;
  timezone: string | null;
  status: string;
  location: string | null;
  meetingUrl: string | null;
  organizerName: string | null;
  organizerEmail: string | null;
  attendeeCount: number;
  attendees: CalendarAttendee[];
  rawData: Record<string, unknown>;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
  accountEmail: string | null;
  accountDisplayName: string | null;
};

export type CalendarEventSource = {
  accountId: string;
  provider: CalendarProvider;
  sourceName: string | null;
  accountEmail: string | null;
  accountDisplayName: string | null;
};

export type UnifiedCalendarEvent = CalendarEvent & {
  sources: CalendarEventSource[];
};

export type CalendarSyncJob = {
  id: string;
  workspaceId: string;
  accountId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  eventsSynced: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderCalendarEvent = {
  providerEventId: string;
  sourceId?: string | null;
  sourceName?: string | null;
  title: string;
  description?: string | null;
  startAt: string;
  endAt: string;
  timezone?: string | null;
  status?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  organizerName?: string | null;
  organizerEmail?: string | null;
  attendees?: CalendarAttendee[];
  rawData?: Record<string, unknown>;
};

export type ProviderCalendarSyncResult = {
  account: {
    externalAccountId?: string | null;
    emailAddress?: string | null;
    displayName?: string | null;
    settings?: Record<string, unknown>;
  };
  events: ProviderCalendarEvent[];
};
