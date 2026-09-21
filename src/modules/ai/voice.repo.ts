import { query } from '../../db/pool.js';
import type { CloseVoiceSessionInput, CreateVoiceSessionInput, VoiceTranscriptInput } from './voice.validator.js';

export type VoiceSession = {
  id: string;
  workspaceId: string;
  userId: string;
  conversationId: string | null;
  transport: 'webrtc' | 'browser_fallback';
  provider: string;
  providerSessionId: string | null;
  status: 'starting' | 'active' | 'completed' | 'failed' | 'fallback';
  language: string;
  voice: string;
  speed: string;
  mode: 'conversation' | 'dictation';
  metadata: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const sessionSelect = `
  id,
  workspace_id AS "workspaceId",
  user_id AS "userId",
  conversation_id AS "conversationId",
  transport,
  provider,
  provider_session_id AS "providerSessionId",
  status,
  language,
  voice,
  speed::text AS speed,
  mode,
  metadata,
  started_at AS "startedAt",
  ended_at AS "endedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function createSession(
  workspaceId: string,
  userId: string,
  input: CreateVoiceSessionInput,
  transport: 'webrtc' | 'browser_fallback',
  provider: string,
) {
  const { rows } = await query<VoiceSession>(
    `INSERT INTO ai_voice_sessions (
       workspace_id, user_id, conversation_id, transport, provider,
       language, voice, speed, mode, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${sessionSelect}`,
    [
      workspaceId,
      userId,
      input.conversationId ?? null,
      transport,
      provider,
      input.language,
      input.voice,
      input.speed,
      input.mode,
      input.metadata ?? {},
    ],
  );
  return rows[0];
}

export async function findSession(workspaceId: string, userId: string, sessionId: string) {
  const { rows } = await query<VoiceSession>(
    `SELECT ${sessionSelect}
       FROM ai_voice_sessions
      WHERE workspace_id=$1 AND user_id=$2 AND id=$3
      LIMIT 1`,
    [workspaceId, userId, sessionId],
  );
  return rows[0];
}

export async function updateSession(
  workspaceId: string,
  userId: string,
  sessionId: string,
  input: {
    providerSessionId?: string | null;
    status?: VoiceSession['status'];
    transport?: VoiceSession['transport'];
    provider?: string;
    metadata?: Record<string, unknown>;
    ended?: boolean;
  },
) {
  const assignments: string[] = [];
  const values: unknown[] = [workspaceId, userId, sessionId];
  const add = (column: string, value: unknown) => {
    assignments.push(`${column}=$${values.length + 1}`);
    values.push(value);
  };
  if (input.providerSessionId !== undefined) add('provider_session_id', input.providerSessionId);
  if (input.status !== undefined) add('status', input.status);
  if (input.transport !== undefined) add('transport', input.transport);
  if (input.provider !== undefined) add('provider', input.provider);
  if (input.metadata !== undefined) add('metadata', input.metadata);
  if (input.ended) assignments.push('ended_at=NOW()');
  if (!assignments.length) return findSession(workspaceId, userId, sessionId);
  const { rows } = await query<VoiceSession>(
    `UPDATE ai_voice_sessions
        SET ${assignments.join(', ')}
      WHERE workspace_id=$1 AND user_id=$2 AND id=$3
      RETURNING ${sessionSelect}`,
    values,
  );
  return rows[0];
}

export async function addTranscript(
  workspaceId: string,
  userId: string,
  sessionId: string,
  input: VoiceTranscriptInput,
) {
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO ai_voice_transcripts (
       workspace_id, session_id, conversation_id, direction, content,
       sequence_number, is_final, source, started_at, ended_at, metadata
     )
     SELECT $1, s.id, s.conversation_id, $4, $5, $6, $7, $8, $9, $10, $11
       FROM ai_voice_sessions s
      WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.id=$3
     RETURNING id,
       session_id AS "sessionId",
       conversation_id AS "conversationId",
       direction, content,
       sequence_number AS "sequenceNumber",
       is_final AS "isFinal",
       source, started_at AS "startedAt", ended_at AS "endedAt",
       metadata, created_at AS "createdAt"`,
    [
      workspaceId,
      userId,
      sessionId,
      input.direction,
      input.content,
      input.sequenceNumber,
      input.isFinal,
      input.source,
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.metadata ?? {},
    ],
  );
  return rows[0];
}

export async function finishSession(
  workspaceId: string,
  userId: string,
  sessionId: string,
  input: CloseVoiceSessionInput,
) {
  const update: Parameters<typeof updateSession>[3] = {
    status: input.status,
    ended: true,
  };
  if (input.metadata) update.metadata = input.metadata;
  return updateSession(workspaceId, userId, sessionId, update);
}
