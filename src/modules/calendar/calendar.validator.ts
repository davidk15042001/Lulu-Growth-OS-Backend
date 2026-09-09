import { z } from 'zod';

export const workspaceParams = z.object({ workspaceId: z.string().uuid() });
export const accountParams = workspaceParams.extend({ accountId: z.string().uuid() });
export const syncJobParams = accountParams.extend({ jobId: z.string().uuid() });
export const nativeEventParams = workspaceParams.extend({ eventId: z.string().uuid() });
export const publicNativeEventParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) });

export const oauthStartSchema = z.object({
  provider: z.enum(['google', 'microsoft']),
  returnTo: z.string().trim().max(500).optional(),
});

export const tokenConnectSchema = z.object({
  provider: z.enum(['calendly', 'calcom']),
  apiKey: z.string().trim().min(1).max(4000),
  displayName: z.string().trim().max(200).optional(),
  baseUrl: z.string().trim().url().max(500).optional(),
});

const isoDateTime = z.string().datetime({ offset: true });

export const listEventsQuery = z.object({
  accountId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
});

export const createNativeEventSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(5000).optional().nullable(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  timezone: z.string().trim().min(1).max(100).default('UTC'),
  location: z.string().trim().max(500).optional().nullable(),
}).superRefine((value, ctx) => {
  if (new Date(value.endAt).getTime() <= new Date(value.startAt).getTime()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'End time must be after start time' });
});

export const listNativeEventsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
});

export type CreateNativeEventInput = z.infer<typeof createNativeEventSchema>;
export type ListNativeEventsQuery = z.infer<typeof listNativeEventsQuery>;

export type ListEventsQuery = z.infer<typeof listEventsQuery>;
