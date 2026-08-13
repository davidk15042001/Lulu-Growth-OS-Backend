import { z } from 'zod';

const jsonObject = z.record(z.string(), z.unknown());

export const conversationParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
});

export const listConversationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  archived: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
});

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  model: z.string().trim().max(200).nullable().optional(),
  metadata: jsonObject.optional(),
});

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    model: z.string().trim().max(200).nullable().optional(),
    metadata: jsonObject.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  metadata: jsonObject.optional(),
});

export const generateResponseSchema = createMessageSchema;

export const listMessagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
