import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import * as service from './finance.service.js';
import { accountBalanceParamsSchema, accountBalanceQuerySchema, journalListQuerySchema, journalParamsSchema, trialBalanceQuerySchema, workspaceFinanceParamsSchema } from './finance.validator.js';

function actorId(req:WorkspaceRequest){if(!req.user?.id)throw new Error('Authentication is required');return req.user.id;}
export async function listJournals(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId}=workspaceFinanceParamsSchema.parse(req.params);return successResponse(res,'Financial journals loaded',await service.listJournals(workspaceId,actorId(req),journalListQuerySchema.parse(req.query)));}catch(error){next(error);}}
export async function getJournal(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId,journalId}=journalParamsSchema.parse(req.params);return successResponse(res,'Financial journal loaded',await service.getJournal(workspaceId,actorId(req),journalId));}catch(error){next(error);}}
export async function getAccountBalance(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId,accountCode}=accountBalanceParamsSchema.parse(req.params);const query=accountBalanceQuerySchema.parse(req.query);return successResponse(res,'Account balance loaded',await service.getAccountBalance(workspaceId,actorId(req),accountCode,query.currency,query.asOf));}catch(error){next(error);}}
export async function getTrialBalance(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId}=workspaceFinanceParamsSchema.parse(req.params);const query=trialBalanceQuerySchema.parse(req.query);return successResponse(res,'Trial balance loaded',await service.getTrialBalance(workspaceId,actorId(req),query.currency,query.asOf));}catch(error){next(error);}}
