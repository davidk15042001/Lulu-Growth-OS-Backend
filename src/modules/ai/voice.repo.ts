import { query } from '../../db/pool.js';
import type { CloseVoiceSessionInput, CreateVoiceSessionInput, VoiceTranscriptInput } from './voice.validator.js';

export type VoiceSession = {
  id: string;
  workspaceId: string;
  userId: string;
  clientSessionId: string | null;
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
  client_session_id AS "clientSessionId",
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
       language, voice, speed, mode, metadata, client_session_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (workspace_id, user_id, client_session_id)
       WHERE client_session_id IS NOT NULL
       DO NOTHING
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
      input.clientSessionId ?? null,
    ],
  );
  if (rows[0]) return rows[0];
  const existing = await query<VoiceSession>(
    `SELECT ${sessionSelect}
       FROM ai_voice_sessions
      WHERE workspace_id=$1 AND user_id=$2 AND client_session_id=$3
      LIMIT 1`,
    [workspaceId, userId, input.clientSessionId],
  );
  return existing.rows[0];
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
       sequence_number, is_final, source, started_at, ended_at, metadata, client_event_id
     )
     SELECT $1, s.id, s.conversation_id, $4, $5, $6, $7, $8, $9, $10, $11, $12
       FROM ai_voice_sessions s
      WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.id=$3 AND s.ended_at IS NULL
     ON CONFLICT (workspace_id, session_id, direction, client_event_id)
       WHERE client_event_id IS NOT NULL
       DO NOTHING
     RETURNING id,
       session_id AS "sessionId",
       conversation_id AS "conversationId",
       direction, content,
       sequence_number AS "sequenceNumber",
       is_final AS "isFinal",
       source, started_at AS "startedAt", ended_at AS "endedAt",
       metadata, client_event_id AS "clientEventId", created_at AS "createdAt"`,
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
      input.clientEventId ?? null,
    ],
  );
  if (rows[0]) return rows[0];
  if (input.clientEventId) {
    const existing = await query<Record<string, unknown>>(
      `SELECT id,
              session_id AS "sessionId",
              conversation_id AS "conversationId",
              direction, content,
              sequence_number AS "sequenceNumber",
              is_final AS "isFinal",
              source, started_at AS "startedAt", ended_at AS "endedAt",
              metadata, client_event_id AS "clientEventId", created_at AS "createdAt"
         FROM ai_voice_transcripts
        WHERE workspace_id=$1 AND session_id=$2 AND direction=$3 AND client_event_id=$4
        LIMIT 1`,
      [workspaceId, sessionId, input.direction, input.clientEventId],
    );
    return existing.rows[0];
  }
  return undefined;
}

export async function listTranscripts(workspaceId: string, userId: string, sessionId: string, limit = 500) {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id,
            session_id AS "sessionId",
            conversation_id AS "conversationId",
            direction, content,
            sequence_number AS "sequenceNumber",
            is_final AS "isFinal",
            source, started_at AS "startedAt", ended_at AS "endedAt",
            metadata, client_event_id AS "clientEventId", created_at AS "createdAt"
       FROM ai_voice_transcripts
      WHERE workspace_id=$1 AND session_id=$2
        AND EXISTS (
          SELECT 1 FROM ai_voice_sessions s
           WHERE s.id=$2 AND s.workspace_id=$1 AND s.user_id=$3
        )
      ORDER BY sequence_number ASC, created_at ASC, id ASC
      LIMIT $4`,
    [workspaceId, sessionId, userId, boundedLimit],
  );
  return rows;
}

export async function deleteSession(workspaceId: string, userId: string, sessionId: string) {
  const { rows } = await query<{ id: string }>(
    `DELETE FROM ai_voice_sessions
      WHERE workspace_id=$1 AND user_id=$2 AND id=$3
      RETURNING id`,
    [workspaceId, userId, sessionId],
  );
  return rows[0] ?? null;
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
