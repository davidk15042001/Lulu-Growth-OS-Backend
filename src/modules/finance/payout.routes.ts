import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import * as controller from './payout.controller.js';

const router = Router({ mergeParams: true });
router.route('/payouts').get(requireWorkspaceCapability('payouts.request'), controller.list).post(requireWorkspaceCapability('payouts.request'), controller.request).all(methodNotAllowed);
router.route('/payout-accounts').post(requireWorkspaceCapability('payouts.manage'), controller.createAccount).all(methodNotAllowed);
router.route('/payouts/:payoutId/submit').post(requireWorkspaceCapability('payouts.manage'), controller.submit).all(methodNotAllowed);

export default router;
