import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceSessionSchema, voiceSpeechSchema, voiceTranscriptSchema } from '../src/modules/ai/voice.validator.js';

test('voice session accepts a retry-safe client session id', () => {
  const clientSessionId = '11111111-1111-4111-8111-111111111111';
  const parsed = createVoiceSessionSchema.parse({ clientSessionId });
  assert.equal(parsed.clientSessionId, clientSessionId);
});

test('voice transcript accepts a retry-safe client event id', () => {
  const clientEventId = '22222222-2222-4222-8222-222222222222';
  const parsed = voiceTranscriptSchema.parse({
    clientEventId,
    direction: 'input',
    content: 'Create the weekly report',
    sequenceNumber: 0,
    source: 'browser_fallback',
  });
  assert.equal(parsed.clientEventId, clientEventId);
  assert.equal(parsed.isFinal, true);
});

test('voice speech accepts a stable request id for metering retries', () => {
  const requestId = '33333333-3333-4333-8333-333333333333';
  const parsed = voiceSpeechSchema.parse({
    requestId,
    text: 'Hello Lulu',
    language: 'en-US',
    voice: 'marin',
    speed: 1,
  });
  assert.equal(parsed.requestId, requestId);
});
