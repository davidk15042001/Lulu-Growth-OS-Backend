import { Router } from 'express';
import multer from 'multer';
import type { NextFunction, Response } from 'express';
import {
  requireWorkspaceCapability,
  type WorkspaceRequest,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './record.controller.js';
import { getResourceDefinition } from '../../domain/resource-catalog.js';
import type { WorkspaceCapability } from '../workspaces/workspace-permissions.js';

const router = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 50 } });

/**
 * The records API is a compatibility surface used by several older pages.
 * It must still enforce the same domain boundary as the canonical module
 * routes; workspace.read/write alone would let a role cross into another
 * department by changing only :resourceType in the URL.
 */
function capabilityForResource(resourceType: string, action: 'read' | 'write' | 'manage'): WorkspaceCapability {
  const definition = getResourceDefinition(resourceType);
  const domain = definition?.domain;
  if (domain === 'crm') {
    if (resourceType === 'crm_leads') return action === 'read' ? 'leads.read' : 'leads.manage';
    if (resourceType === 'crm_deals') return action === 'read' ? 'opportunities.read' : 'opportunities.manage';
    return action === 'read' ? 'crm.read' : 'crm.manage';
  }
  if (domain === 'sales') {
    if (resourceType.includes('lead')) return action === 'read' ? 'leads.read' : 'leads.manage';
    if (resourceType.includes('opportunit') || resourceType.includes('deal')) return action === 'read' ? 'opportunities.read' : 'opportunities.manage';
    return action === 'read' ? 'crm.read' : 'crm.manage';
  }
  if (domain === 'marketing') return action === 'read' ? 'social.read' : 'social.manage';
  if (domain === 'advertising') return action === 'read' ? 'advertising.read' : 'advertising.manage';
  if (domain === 'ecommerce') {
    if (resourceType.includes('product') || resourceType === 'ecommerce_categories' || resourceType === 'ecommerce_collections') {
      return action === 'read' ? 'products.read' : 'products.update';
    }
    return action === 'read' ? 'orders.read' : 'orders.manage';
  }
  if (domain === 'finance') return action === 'read' ? 'finance.read' : 'finance.manage';
  if (domain === 'ai' || domain === 'intelligence') return action === 'read' ? 'agents.read' : 'agents.manage';
  if (action === 'read') return 'workspace.read';
  return action === 'manage' ? 'workspace.manage' : 'workspace.write';
}

function requireRecordCapability(action: 'read' | 'write' | 'manage') {
  return (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    const capability = capabilityForResource(String(req.params.resourceType ?? ''), action);
    return requireWorkspaceCapability(capability)(req, res, next);
  };
}

router.route('/:resourceType')
  .get(requireRecordCapability('read'), controller.list)
  .post(requireRecordCapability('write'), controller.create)
  .all(methodNotAllowed);

router.route('/:resourceType/upload')
  .post(requireRecordCapability('write'), upload.array('files', 50), controller.upload)
  .all(methodNotAllowed);

router.route('/:resourceType/:recordId')
  .get(requireRecordCapability('read'), controller.get)
  .patch(requireRecordCapability('write'), controller.update)
  .delete(requireRecordCapability('write'), controller.archive)
  .all(methodNotAllowed);

router.route('/:resourceType/:recordId/restore')
  .post(requireRecordCapability('manage'), controller.restore)
  .all(methodNotAllowed);

router.route('/:resourceType/:recordId/enrich')
  .post(requireRecordCapability('write'), controller.enrichCompany)
  .all(methodNotAllowed);

export default router;
