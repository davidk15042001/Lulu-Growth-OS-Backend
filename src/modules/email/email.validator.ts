import { z } from 'zod';

export const workspaceParams = z.object({ workspaceId: z.string().uuid() });
export const accountParams = workspaceParams.extend({ accountId: z.string().uuid() });
export const syncJobParams = accountParams.extend({ jobId: z.string().uuid() });
export const threadParams = workspaceParams.extend({ threadId: z.string().uuid() });
export const messageParams = workspaceParams.extend({ messageId: z.string().uuid() });
export const draftParams = workspaceParams.extend({ draftId: z.string().uuid() });
export const ruleParams = workspaceParams.extend({ ruleId: z.string().uuid() });

export const oauthStartSchema = z.object({
  provider: z.enum(['google', 'microsoft']),
  returnTo: z.string().trim().max(500).optional(),
});

const publicMailHostname = z.string().trim().toLowerCase().min(4).max(253).regex(
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  'Use a public fully qualified mail server hostname',
);

export const imapConnectSchema = z.object({
  emailAddress: z.string().trim().email().max(320),
  displayName: z.string().trim().max(200).optional(),
  password: z.string().min(1).max(1000),
  imapHost: publicMailHostname,
  imapPort: z.coerce.number().int().refine((value) => [143, 993].includes(value), 'Use IMAP port 143 or 993').default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: publicMailHostname,
  smtpPort: z.coerce.number().int().refine((value) => [25, 465, 587, 2525].includes(value), 'Use SMTP port 25, 465, 587 or 2525').default(465),
  smtpSecure: z.boolean().default(true),
});

export const listThreadsQuery = z.object({
  accountId: z.string().uuid().optional(),
  folderId: z.string().trim().max(1000).optional(),
  q: z.string().trim().max(200).optional(),
  unread: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  starred: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const emailAddressSchema = z.object({
  name: z.string().trim().max(200).nullish(),
  address: z.string().trim().email().max(320),
});

export const createDraftSchema = z.object({
  accountId: z.string().uuid(),
  threadId: z.string().uuid().nullish(),
  to: z.array(emailAddressSchema).min(1).max(100),
  cc: z.array(emailAddressSchema).max(100).default([]),
  subject: z.string().trim().max(998).default(''),
  bodyText: z.string().trim().min(1).max(100_000),
  replyToProviderMessageId: z.string().trim().max(1000).nullish(),
});

export const updateDraftSchema = createDraftSchema.omit({ accountId: true, threadId: true }).partial();

export const aiDraftSchema = z.object({
  accountId: z.string().uuid(),
  instruction: z.string().trim().max(2000).optional(),
  tone: z.enum(['professional', 'friendly', 'concise', 'empathetic']).default('professional'),
  language: z.enum(['en', 'de', 'zh-CN']).default('en'),
});

export const messageStateSchema = z.object({
  isRead: z.boolean().optional(),
  starred: z.boolean().optional(),
}).refine((value) => value.isRead !== undefined || value.starred !== undefined, 'At least one state must be supplied');

const ruleConditions = z.object({
  senderContains: z.string().trim().max(320).optional(),
  subjectContains: z.string().trim().max(200).optional(),
  bodyContains: z.string().trim().max(200).optional(),
  onlyUnread: z.boolean().default(true),
});

const ruleAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generate_ai_draft'), tone: z.enum(['professional', 'friendly', 'concise', 'empathetic']).default('professional'), language: z.enum(['en', 'de', 'zh-CN']).default('en') }),
  z.object({ type: z.literal('mark_read') }),
  z.object({ type: z.literal('star') }),
]);

export const createRuleSchema = z.object({
  accountId: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  conditions: ruleConditions,
  actions: z.array(ruleAction).min(1).max(10),
});

export const updateRuleSchema = createRuleSchema.partial();

export type ListThreadsQuery = z.infer<typeof listThreadsQuery>;
export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
