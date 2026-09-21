import crypto from 'node:crypto';
import OpenAI from 'openai';
import { env, hasOpenAI } from '../../config/env.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import { recordMeteredUsage } from '../usage/usage.service.js';
import * as repo from './voice.repo.js';
import type { CloseVoiceSessionInput, CreateVoiceSessionInput, VoiceSpeechInput, VoiceTranscriptInput } from './voice.validator.js';

function providerLanguage(language: string) {
  return language.trim().split('-')[0]?.toLowerCase() || 'en';
}

function safeProviderError(body: string) {
  return body.replaceAll(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)/gi, '[redacted]').slice(0, 500);
}

async function openAiRealtimeAnswer(input: CreateVoiceSessionInput) {
  if (!hasOpenAI || !env.OPENAI_API_KEY || !input.sdp) return null;
  const form = new FormData();
  form.set('sdp', input.sdp);
  form.set('session', JSON.stringify({
    type: 'realtime',
    model: env.OPENAI_REALTIME_MODEL,
    output_modalities: ['text'],
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: {
          model: env.OPENAI_TRANSCRIPTION_MODEL,
          language: providerLanguage(input.language),
        },
        turn_detection: {
          type: 'server_vad',
          create_response: false,
          interrupt_response: true,
          prefix_padding_ms: 300,
          silence_duration_ms: env.OPENAI_VOICE_VAD_SILENCE_MS,
          threshold: env.OPENAI_VOICE_VAD_THRESHOLD,
        },
      },
      output: { voice: input.voice, speed: input.speed },
    },
    instructions: 'This session is a governed Lulu voice transport. Do not answer or execute actions automatically. Emit input audio transcription events; Lulu will route the final transcript through its authenticated agent and action gateway.',
    max_output_tokens: 1,
  }));

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new AppError(503, 'VOICE_REALTIME_UNAVAILABLE', `The realtime voice provider could not establish a session (${response.status}: ${safeProviderError(body)})`);
  }
  const location = response.headers.get('location');
  const providerSessionId = location?.split('/').filter(Boolean).pop() ?? null;
  return { sdpAnswer: body, providerSessionId };
}

export async function createSession(workspaceId: string, userId: string, input: CreateVoiceSessionInput) {
  const wantsRealtime = Boolean(input.sdp && hasOpenAI);
  const transport = wantsRealtime ? 'webrtc' : 'browser_fallback';
  const provider = wantsRealtime ? 'openai-realtime' : 'browser';
  const session = await repo.createSession(workspaceId, userId, input, transport, provider);
  if (!session) throw new Error('Voice session insert did not return a row');

  if (!wantsRealtime) {
    await repo.updateSession(workspaceId, userId, session.id, { status: 'fallback' });
    return { session: await repo.findSession(workspaceId, userId, session.id), transport, provider, sdpAnswer: null };
  }

  try {
    const answer = await openAiRealtimeAnswer(input);
    if (!answer) throw new AppError(503, 'VOICE_REALTIME_UNAVAILABLE', 'Realtime voice is not configured on the server.');
    const active = await repo.updateSession(workspaceId, userId, session.id, {
      status: 'active',
      providerSessionId: answer.providerSessionId,
    });
    return { session: active, transport, provider, sdpAnswer: answer.sdpAnswer };
  } catch (error) {
    await repo.updateSession(workspaceId, userId, session.id, { status: 'failed', ended: true }).catch(() => undefined);
    throw error;
  }
}

export async function addTranscript(workspaceId: string, userId: string, sessionId: string, input: VoiceTranscriptInput) {
  const session = await repo.findSession(workspaceId, userId, sessionId);
  if (!session) throw notFoundError('Voice session not found');
  const transcript = await repo.addTranscript(workspaceId, userId, sessionId, input);
  if (!transcript) throw notFoundError('Voice session not found');
  return transcript;
}

export async function closeSession(workspaceId: string, userId: string, sessionId: string, input: CloseVoiceSessionInput) {
  const session = await repo.findSession(workspaceId, userId, sessionId);
  if (!session) throw notFoundError('Voice session not found');
  const closed = await repo.finishSession(workspaceId, userId, sessionId, input);
  if (session.provider === 'openai-realtime' && session.status === 'active' && env.VOICE_REALTIME_COST_USD_PER_MINUTE > 0) {
    const startedAt = Date.parse(session.startedAt);
    const durationMinutes = Math.max(0, (Date.now() - (Number.isFinite(startedAt) ? startedAt : Date.now())) / 60_000);
    const providerCostUsd = durationMinutes * env.VOICE_REALTIME_COST_USD_PER_MINUTE;
    await recordMeteredUsage({
      workspaceId,
      userId,
      provider: 'openai',
      model: env.OPENAI_REALTIME_MODEL,
      providerCostUsd,
      customerCostUsd: providerCostUsd * env.VOICE_CUSTOMER_MARKUP_MULTIPLIER,
      responseId: `voice-session:${session.id}`,
      providerRequestId: session.providerSessionId,
      metadata: { kind: 'voice_realtime', sessionId: session.id, durationMinutes },
    });
  }
  return closed;
}

export async function synthesizeSpeech(workspaceId: string, userId: string, input: VoiceSpeechInput) {
  if (!hasOpenAI || !env.OPENAI_API_KEY) throw new AppError(503, 'VOICE_TTS_NOT_CONFIGURED', 'Server-side voice output is not configured.');
  if (input.sessionId) {
    const session = await repo.findSession(workspaceId, userId, input.sessionId);
    if (!session) throw notFoundError('Voice session not found');
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
  const response = await client.audio.speech.create({
    model: env.OPENAI_TTS_MODEL,
    voice: input.voice as never,
    input: input.text,
    response_format: 'mp3',
    speed: input.speed,
  } as never);
  const audio = Buffer.from(await response.arrayBuffer());
  const responseId = `voice-tts:${crypto.randomUUID()}`;
  const providerCostUsd = (input.text.length / 1_000) * env.VOICE_TTS_COST_USD_PER_1K_CHARS;
  if (providerCostUsd > 0) {
    await recordMeteredUsage({
      workspaceId,
      userId,
      provider: 'openai',
      model: env.OPENAI_TTS_MODEL,
      providerCostUsd,
      customerCostUsd: providerCostUsd * env.VOICE_CUSTOMER_MARKUP_MULTIPLIER,
      responseId,
      providerRequestId: response.headers.get('x-request-id'),
      metadata: { kind: 'voice_tts', characters: input.text.length, language: input.language, voice: input.voice, speed: input.speed },
    });
  }
  return { responseId, contentType: 'audio/mpeg', audioBase64: audio.toString('base64'), billed: providerCostUsd > 0 };
}
