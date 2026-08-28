import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './onboarding.controller.js';

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5000 * 1024, files: 1 } });

function uploadDiagnostic(req: Request) {
  return {
    requestId: String(req.id || 'request-id-unavailable'),
    endpoint: `${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
  };
}

function parseDocumentUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      const diagnostics = uploadDiagnostic(req);
      res.setHeader('X-Request-ID', diagnostics.requestId);
      return res.status(413).json({ success: false, error: { code: 'FILE_TOO_LARGE', message: 'The file must be smaller than 5,000 KB', diagnostics } });
    }
    if (error) return next(error);
    return next();
  });
}

router.route('/')
  .get(requireWorkspaceMember, controller.snapshot)
  .all(methodNotAllowed);

router.route('/company-information')
  .patch(requireWorkspaceEditor, controller.companyInformation)
  .all(methodNotAllowed);

router.route('/business-description')
  .patch(requireWorkspaceEditor, controller.businessDescription)
  .all(methodNotAllowed);

router.route('/documents')
  .get(requireWorkspaceMember, controller.listDocuments)
  .post(requireWorkspaceEditor, parseDocumentUpload, controller.uploadDocument)
  .all(methodNotAllowed);

router.route('/documents/:documentId/content')
  .get(requireWorkspaceMember, controller.documentContent)
  .all(methodNotAllowed);

router.route('/documents/:documentId')
  .delete(requireWorkspaceEditor, controller.deleteDocument)
  .all(methodNotAllowed);

router.route('/offerings')
  .get(requireWorkspaceMember, controller.listOfferings)
  .post(requireWorkspaceEditor, controller.createOffering)
  .all(methodNotAllowed);

router.route('/offerings/:offeringId')
  .patch(requireWorkspaceEditor, controller.updateOffering)
  .delete(requireWorkspaceEditor, controller.deleteOffering)
  .all(methodNotAllowed);

router.route('/customer-segments')
  .get(requireWorkspaceMember, controller.listCustomerSegments)
  .post(requireWorkspaceEditor, controller.createCustomerSegment)
  .all(methodNotAllowed);

router.route('/customer-segments/:customerSegmentId')
  .patch(requireWorkspaceEditor, controller.updateCustomerSegment)
  .delete(requireWorkspaceEditor, controller.deleteCustomerSegment)
  .all(methodNotAllowed);

router.route('/platforms')
  .get(requireWorkspaceMember, controller.listPlatforms)
  .post(requireWorkspaceEditor, controller.createPlatform)
  .all(methodNotAllowed);

router.route('/platforms/:platformId')
  .patch(requireWorkspaceEditor, controller.updatePlatform)
  .delete(requireWorkspaceEditor, controller.deletePlatform)
  .all(methodNotAllowed);

router.route('/existing-platforms/continue')
  .post(requireWorkspaceEditor, controller.continueExistingPlatforms)
  .all(methodNotAllowed);

router.route('/platforms/:provider/connect')
  .get(requireWorkspaceEditor, controller.startOAuth)
  .all(methodNotAllowed);

router.route('/competitors')
  .get(requireWorkspaceMember, controller.listCompetitors)
  .post(requireWorkspaceEditor, controller.createCompetitor)
  .all(methodNotAllowed);

router.route('/competitors/discover')
  .post(requireWorkspaceEditor, controller.discoverCompetitors)
  .all(methodNotAllowed);

router.route('/competitors/:competitorId')
  .patch(requireWorkspaceEditor, controller.updateCompetitor)
  .delete(requireWorkspaceEditor, controller.deleteCompetitor)
  .all(methodNotAllowed);

router.route('/ai-preferences')
  .get(requireWorkspaceMember, controller.getAiPreferences)
  .put(requireWorkspaceEditor, controller.saveAiPreferences)
  .all(methodNotAllowed);

router.route('/complete')
  .post(requireWorkspaceEditor, controller.complete)
  .all(methodNotAllowed);

export default router;
