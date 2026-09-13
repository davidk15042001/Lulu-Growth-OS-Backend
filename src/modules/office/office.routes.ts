import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './office.controller.js';

const router = Router({ mergeParams: true });
const canReadOffice = requireWorkspaceCapability('agents.read', { enforceWriteEntitlement: false });
const canControlOffice = requireWorkspaceCapability('agents.manage');

router.route('/overview')
  .get(canReadOffice, controller.overview)
  .all(methodNotAllowed);
router.route('/timeline')
  .get(canReadOffice, controller.timeline)
  .all(methodNotAllowed);
router.route('/employees/:employeeId')
  .get(canReadOffice, controller.employeeDetail)
  .all(methodNotAllowed);
router.route('/employees/:employeeId/work')
  .get(canReadOffice, controller.employeeWork)
  .all(methodNotAllowed);
router.route('/work-items/:workItemId/:action')
  .post(canControlOffice, controller.controlWorkItem)
  .all(methodNotAllowed);

export default router;
