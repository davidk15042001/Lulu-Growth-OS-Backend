import { z } from 'zod';

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(240);
const version = z.coerce.number().int().positive();
const httpsUrl = z.string().trim().url().max(2048).refine((value) => value.startsWith('https://'), 'A public HTTPS URL is required');
const metadata = z.record(z.string(), z.unknown()).default({});

export const workspaceParamsSchema = z.object({ workspaceId: uuid });
export const accountParamsSchema = workspaceParamsSchema.extend({ accountId: uuid });
export const contentParamsSchema = workspaceParamsSchema.extend({ contentId: uuid });
export const publicationParamsSchema = workspaceParamsSchema.extend({ publicationId: uuid });

export const createSocialAccountSchema = z.object({
  providerConnectionId: uuid,
  provider: z.enum(['FACEBOOK','INSTAGRAM']),
  displayName: z.string().trim().min(1).max(200),
  facebookPageId: z.string().regex(/^[0-9]{2,40}$/),
  instagramBusinessAccountId: z.string().regex(/^[0-9]{2,40}$/).nullable().optional(),
  idempotencyKey,
}).superRefine((value, ctx) => {
  if (value.provider === 'INSTAGRAM' && !value.instagramBusinessAccountId) ctx.addIssue({ code: 'custom', path: ['instagramBusinessAccountId'], message: 'An exact Instagram Business account id is required.' });
  if (value.provider === 'FACEBOOK' && value.instagramBusinessAccountId) ctx.addIssue({ code: 'custom', path: ['instagramBusinessAccountId'], message: 'Facebook Page accounts cannot include an Instagram Business account id.' });
});

export const verifySocialAccountSchema = z.object({ expectedVersion: version });

const contentShape = {
  contentType: z.enum(['TEXT','LINK','IMAGE']),
  status: z.enum(['DRAFT','READY']).default('DRAFT'),
  message: z.string().max(63206).default(''),
  linkUrl: httpsUrl.nullable().optional(),
  mediaUrl: httpsUrl.nullable().optional(),
  altText: z.string().trim().max(1000).nullable().optional(),
  metadata,
};

export const createSocialContentSchema = z.object({
  ...contentShape,
  idempotencyKey,
});

export const updateSocialContentSchema = z.object({
  expectedVersion: version,
  status: z.enum(['DRAFT','READY','ARCHIVED']).optional(),
  message: z.string().max(63206).optional(),
  linkUrl: httpsUrl.nullable().optional(),
  mediaUrl: httpsUrl.nullable().optional(),
  altText: z.string().trim().max(1000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'At least one content field is required');

export const socialContentListQuerySchema = z.object({ status: z.enum(['DRAFT','READY','ARCHIVED']).optional() });

export const createSocialPublicationSchema = z.object({
  socialAccountId: uuid,
  contentId: uuid,
  execution: z.enum(['DRAFT','QUEUE']).default('QUEUE'),
  scheduledAt: z.string().datetime().nullable().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(20).default(5),
  idempotencyKey,
});

export const socialPublicationListQuerySchema = z.object({
  status: z.enum(['DRAFT','SCHEDULED','QUEUED','PUBLISHING','PUBLISHED','FAILED','CANCELLED','BLOCKED']).optional(),
});

export const transitionSocialPublicationSchema = z.object({
  expectedVersion: version,
  scheduledAt: z.string().datetime().nullable().optional(),
});
