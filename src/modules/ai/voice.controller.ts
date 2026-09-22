import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './voice.service.js';
import { closeVoiceSessionSchema, createVoiceSessionSchema, voiceSpeechSchema, voiceTranscriptSchema } from './voice.validator.js';

function sessionId(req: WorkspaceRequest) {
  return String(req.params.sessionId ?? '');
}

export async function createSession(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = createVoiceSessionSchema.parse(req.body);
    return createdResponse(res, 'Voice session created', await service.createSession(req.workspaceAccess!.id, req.user!.id, input));
  } catch (error) { next(error); }
}

export async function addTranscript(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = voiceTranscriptSchema.parse(req.body);
    return createdResponse(res, 'Voice transcript saved', await service.addTranscript(req.workspaceAccess!.id, req.user!.id, sessionId(req), input));
  } catch (error) { next(error); }
}

export async function getSession(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    return successResponse(res, 'Voice session loaded', await service.getSession(req.workspaceAccess!.id, req.user!.id, sessionId(req)));
  } catch (error) { next(error); }
}

export async function getTranscripts(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    return successResponse(res, 'Voice transcripts loaded', await service.getTranscripts(req.workspaceAccess!.id, req.user!.id, sessionId(req)));
  } catch (error) { next(error); }
}

export async function deleteSession(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    return successResponse(res, 'Voice session deleted', await service.deleteSession(req.workspaceAccess!.id, req.user!.id, sessionId(req)));
  } catch (error) { next(error); }
}

export async function closeSession(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = closeVoiceSessionSchema.parse(req.body ?? {});
    return successResponse(res, 'Voice session closed', await service.closeSession(req.workspaceAccess!.id, req.user!.id, sessionId(req), input));
  } catch (error) { next(error); }
}

export async function speech(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = voiceSpeechSchema.parse(req.body);
    return successResponse(res, 'Voice audio generated', await service.synthesizeSpeech(req.workspaceAccess!.id, req.user!.id, input));
  } catch (error) { next(error); }
}
