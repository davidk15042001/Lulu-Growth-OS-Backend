import { Router } from 'express';
import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { requireWorkspaceMember, type WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { requireAdminCapabilities } from '../admin/admin.authorization.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import * as repo from './support.repo.js';
import { dbRateLimit } from '../../middlewares/rateLimit.middleware.js';

const pagination=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)});
const body=z.string().trim().min(1).max(10000);
const createSchema=z.object({subject:z.string().trim().min(1).max(200),body,category:z.enum(['general','billing','technical']).default('general')}).strict();
const updateSchema=z.object({body:body.optional(),status:z.enum(['open','waiting_customer','resolved','closed']).optional()}).strict().refine(v=>v.body||v.status,'A reply or status is required');
function handlers(admin:boolean) {
  const actor=(req:AuthedRequest):repo.SupportActor=>admin?{adminId:req.user!.id}:{userId:req.user!.id,workspaceId:(req as WorkspaceRequest).workspaceAccess!.id};
  const list:RequestHandler=async(req,res,next)=>{try{const p=pagination.parse(req.query);successResponse(res,'Support tickets loaded',{tickets:await repo.list(actor(req),p.limit,p.offset)});}catch(e){next(e);}};
  const detail:RequestHandler=async(req,res,next)=>{try{const p=pagination.parse(req.query);successResponse(res,'Support ticket loaded',await repo.detail(actor(req),z.string().uuid().parse(req.params.ticketId),p.limit,p.offset));}catch(e){next(e);}};
  const respond:RequestHandler=async(req,res,next)=>{try{const input=admin?updateSchema.parse(req.body):z.object({body}).strict().parse(req.body);successResponse(res,'Support ticket updated',await repo.respond(actor(req),z.string().uuid().parse(req.params.ticketId),input));}catch(e){next(e);}};
  return {list,detail,respond};
}
export const supportRoutes=Router({mergeParams:true});
supportRoutes.use(requireWorkspaceMember);
supportRoutes.use(dbRateLimit({keyPrefix:'support',windowMs:60000,limit:60}));
const user=handlers(false);
supportRoutes.get('/',user.list);
supportRoutes.post('/',async(req:WorkspaceRequest,res,next)=>{try{createdResponse(res,'Support ticket created',await repo.create(req.workspaceAccess!.id,req.user!.id,createSchema.parse(req.body)));}catch(e){next(e);}});
supportRoutes.get('/:ticketId',user.detail);
supportRoutes.post('/:ticketId/messages',user.respond);
export const adminSupportRoutes=Router();
const admin=handlers(true);
adminSupportRoutes.get('/',requireAdminCapabilities('support.read'),admin.list);
adminSupportRoutes.get('/:ticketId',requireAdminCapabilities('support.read'),admin.detail);
adminSupportRoutes.post('/:ticketId/messages',requireAdminCapabilities('support.manage'),admin.respond);
