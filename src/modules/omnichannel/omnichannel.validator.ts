import { z } from 'zod';

export const listConversationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['OPEN','ACTIVE','WAITING_CUSTOMER','WAITING_LULU','ESCALATED','RESOLVED','CLOSED','SPAM']).optional(),
  handlingMode: z.enum(['AI_AUTO','AI_ASSISTED','HUMAN','ESCALATED']).optional(), channelId: z.string().uuid().optional(),
  assignedUserId: z.string().uuid().optional(), search: z.string().trim().max(200).optional(),
});
export const conversationParamsSchema = z.object({ workspaceId: z.string().uuid(), conversationId: z.string().uuid() });
export const workspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const sendMessageSchema = z.object({ text: z.string().trim().min(1).max(10000), messageType: z.enum(['TEXT','IMAGE','FILE','AUDIO','VIDEO','LOCATION','CONTACT','TEMPLATE']).default('TEXT'), clientMessageId: z.string().trim().max(200).optional() });
export const noteSchema = z.object({ text: z.string().trim().min(1).max(10000) });
export const updateConversationSchema = z.object({ status: z.enum(['OPEN','ACTIVE','WAITING_CUSTOMER','WAITING_LULU','ESCALATED','RESOLVED','CLOSED','SPAM']).optional(), priority: z.enum(['LOW','NORMAL','HIGH','URGENT']).optional(), handlingMode: z.enum(['AI_AUTO','AI_ASSISTED','HUMAN','ESCALATED']).optional(), assignedUserId: z.string().uuid().nullable().optional() }).refine(v => Object.keys(v).length > 0, { message: 'At least one field is required' });
export const websiteChatCreateSchema = z.object({ websiteId: z.string().uuid(), welcomeMessage: z.string().trim().max(500).optional(), supportedLanguages: z.array(z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)).max(20).optional(), defaultLanguage: z.string().trim().max(10).optional(), allowedOrigins: z.array(z.string().url()).max(20).optional() });
export const publicSessionSchema = z.object({ widgetId: z.string().trim().min(10).max(200), origin: z.string().url().optional(), visitorId: z.string().trim().max(200).optional(), pageContext: z.record(z.string(), z.unknown()).optional() });
export const publicMessageSchema = z.object({ text: z.string().trim().min(1).max(10000), messageType: z.enum(['TEXT','IMAGE','FILE','AUDIO','VIDEO','LOCATION','CONTACT']).default('TEXT'), clientMessageId: z.string().trim().max(200).optional(), context: z.record(z.string(), z.unknown()).optional() });
export const adminResolveRoutingSchema = z.object({ workspaceId: z.string().uuid(), reason: z.string().trim().min(1).max(500) });
