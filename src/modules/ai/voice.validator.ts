import { z } from 'zod';

const jsonObject = z.record(z.string(), z.unknown());

const voiceSettings = z.object({
  language: z.string().trim().min(2).max(20).default('en-US'),
  voice: z.string().trim().min(1).max(80).default('marin'),
  speed: z.coerce.number().min(0.25).max(1.5).default(1),
  mode: z.enum(['conversation', 'dictation']).default('conversation'),
});

export const createVoiceSessionSchema = voiceSettings.extend({
  conversationId: z.string().uuid().nullable().optional(),
  sdp: z.string().trim().max(250_000).nullable().optional(),
  clientSessionId: z.string().uuid().nullable().optional(),
  metadata: jsonObject.optional(),
});

export const voiceTranscriptSchema = z.object({
  clientEventId: z.string().uuid().nullable().optional(),
  direction: z.enum(['input', 'output']),
  content: z.string().trim().min(1).max(100_000),
  sequenceNumber: z.coerce.number().int().min(0).max(1_000_000),
  isFinal: z.boolean().default(true),
  source: z.enum(['realtime', 'browser_fallback', 'server_tts', 'browser_tts']),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  metadata: jsonObject.optional(),
});

export const closeVoiceSessionSchema = z.object({
  status: z.enum(['completed', 'failed']).default('completed'),
  metadata: jsonObject.optional(),
});

export const voiceSpeechSchema = z.object({
  sessionId: z.string().uuid().nullable().optional(),
  requestId: z.string().uuid().nullable().optional(),
  text: z.string().trim().min(1).max(8_000),
  language: z.string().trim().min(2).max(20).default('en-US'),
  voice: z.string().trim().min(1).max(80).default('marin'),
  speed: z.coerce.number().min(0.25).max(1.5).default(1),
});

export type CreateVoiceSessionInput = z.infer<typeof createVoiceSessionSchema>;
export type VoiceTranscriptInput = z.infer<typeof voiceTranscriptSchema>;
export type CloseVoiceSessionInput = z.infer<typeof closeVoiceSessionSchema>;
export type VoiceSpeechInput = z.infer<typeof voiceSpeechSchema>;
