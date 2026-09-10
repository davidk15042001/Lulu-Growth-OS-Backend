import type { NextFunction,Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse,successResponse } from '../../utils/response.js';
import * as service from './api-wallet.service.js';
import { apiTopupParamsSchema,apiWalletParamsSchema,createApiTopupSchema } from './api-wallet.validator.js';
export async function overview(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId}=apiWalletParamsSchema.parse(req.params);return successResponse(res,'AI wallet loaded',await service.getApiWalletOverview(workspaceId));}catch(error){next(error);}}
export async function createTopup(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId}=apiWalletParamsSchema.parse(req.params);const input=createApiTopupSchema.parse(req.body);return createdResponse(res,'AI wallet payment created',await service.startApiTopup({workspaceId,userId:req.user!.id,...input}));}catch(error){next(error);}}
export async function syncTopup(req:WorkspaceRequest,res:Response,next:NextFunction){try{const{workspaceId,topupId}=apiTopupParamsSchema.parse(req.params);return successResponse(res,'AI wallet payment synchronized',await service.syncApiTopup(workspaceId,topupId));}catch(error){next(error);}}
