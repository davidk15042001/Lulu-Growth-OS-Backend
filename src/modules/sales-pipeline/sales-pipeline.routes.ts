import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceCapability, type WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import type { Response, NextFunction } from 'express';
import * as controller from './sales-pipeline.controller.js';

const router = Router({ mergeParams: true });

function capability(req: WorkspaceRequest, action: 'read' | 'manage') {
  const resourceType = String(req.params.resourceType ?? '');
  if (resourceType.includes('lead')) return action === 'read' ? 'leads.read' : 'leads.manage';
  if (resourceType.includes('opportunit') || resourceType.includes('deal') || resourceType === 'growth_opportunities') {
    return action === 'read' ? 'opportunities.read' : 'opportunities.manage';
  }
  return action === 'read' ? 'crm.read' : 'crm.manage';
}

function requirePipelineCapability(action: 'read' | 'manage') {
  return (req: WorkspaceRequest, res: Response, next: NextFunction) => requireWorkspaceCapability(capability(req, action))(req, res, next);
}

router.route('/:resourceType')
  .get(requirePipelineCapability('read'), controller.list)
  .all(methodNotAllowed);
router.route('/:resourceType/:recordId')
  .get(requirePipelineCapability('read'), controller.get)
  .all(methodNotAllowed);
router.route('/:resourceType/:recordId/transition')
  .post(requirePipelineCapability('manage'), controller.transition)
  .all(methodNotAllowed);

export default router;
