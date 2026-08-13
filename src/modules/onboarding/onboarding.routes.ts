import { Router } from 'express';
import {
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './onboarding.controller.js';

const router = Router({ mergeParams: true });

router.route('/')
  .get(requireWorkspaceMember, controller.snapshot)
  .all(methodNotAllowed);

router.route('/company-information')
  .patch(requireWorkspaceEditor, controller.companyInformation)
  .all(methodNotAllowed);

router.route('/business-description')
  .patch(requireWorkspaceEditor, controller.businessDescription)
  .all(methodNotAllowed);

router.route('/offerings')
  .get(requireWorkspaceMember, controller.listOfferings)
  .post(requireWorkspaceEditor, controller.createOffering)
  .all(methodNotAllowed);

router.route('/offerings/:offeringId')
  .patch(requireWorkspaceEditor, controller.updateOffering)
  .delete(requireWorkspaceEditor, controller.deleteOffering)
  .all(methodNotAllowed);

router.route('/platforms')
  .get(requireWorkspaceMember, controller.listPlatforms)
  .post(requireWorkspaceEditor, controller.createPlatform)
  .all(methodNotAllowed);

router.route('/platforms/:platformId')
  .patch(requireWorkspaceEditor, controller.updatePlatform)
  .delete(requireWorkspaceEditor, controller.deletePlatform)
  .all(methodNotAllowed);

router.route('/ai-preferences')
  .get(requireWorkspaceMember, controller.getAiPreferences)
  .put(requireWorkspaceEditor, controller.saveAiPreferences)
  .all(methodNotAllowed);

router.route('/complete')
  .post(requireWorkspaceEditor, controller.complete)
  .all(methodNotAllowed);

export default router;
