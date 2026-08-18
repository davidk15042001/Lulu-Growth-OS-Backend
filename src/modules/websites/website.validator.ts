import { z } from 'zod';

export const siteIdParams = z.object({ workspaceId: z.string().uuid(), siteId: z.string().uuid() });
export const jobParams = siteIdParams.extend({ jobId: z.string().uuid() });
export const domainParams = siteIdParams.extend({ domainId: z.string().uuid() });
export const createSiteSchema = z.object({
  provider: z.enum(['wordpress', 'webflow', 'managed']),
  ownershipMode: z.enum(['connected', 'managed']),
  name: z.string().trim().min(1).max(200),
  externalSiteId: z.string().trim().max(255).optional(),
  externalSiteUrl: z.string().url().optional(),
});
export const createDomainSchema = z.object({ hostname: z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/) });
export const createJobSchema = z.object({ prompt: z.string().trim().min(10).max(20000) });
