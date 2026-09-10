import { Router } from 'express';
import { requireWorkspaceAdmin,requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './api-wallet.controller.js';
const router=Router({mergeParams:true});
router.route('/').get(requireWorkspaceMember,controller.overview).all(methodNotAllowed);
router.route('/topups').post(requireWorkspaceAdmin,controller.createTopup).all(methodNotAllowed);
router.route('/topups/:topupId/sync').post(requireWorkspaceAdmin,controller.syncTopup).all(methodNotAllowed);
export default router;
