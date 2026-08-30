import { z } from 'zod';

export const workspaceParams = z.object({ workspaceId: z.string().uuid() });
export const accountParams = workspaceParams.extend({ accountId: z.string().uuid() });
export const syncJobParams = accountParams.extend({ jobId: z.string().uuid() });

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

export type ListEventsQuery = z.infer<typeof listEventsQuery>;
