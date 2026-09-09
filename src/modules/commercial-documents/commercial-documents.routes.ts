import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './commercial-documents.controller.js';

const router = Router({ mergeParams: true });
router.route('/quotes').get(requireWorkspaceCapability('quotes.read'), controller.listQuotes).post(requireWorkspaceCapability('quotes.create'), controller.createQuote).all(methodNotAllowed);
router.route('/quotes/:documentId').get(requireWorkspaceCapability('quotes.read'), controller.getQuote).all(methodNotAllowed);
router.route('/quotes/:documentId/revisions').post(requireWorkspaceCapability('quotes.update'), controller.reviseQuote).all(methodNotAllowed);
router.route('/quotes/:documentId/send').post(requireWorkspaceCapability('quotes.send'), controller.sendQuote).all(methodNotAllowed);
router.route('/invoices').get(requireWorkspaceCapability('invoices.read'), controller.listInvoices).post(requireWorkspaceCapability('invoices.create'), controller.createInvoice).all(methodNotAllowed);
router.route('/seller-profile').get(requireWorkspaceCapability('invoices.read'), controller.getDocumentSellerProfile).all(methodNotAllowed);
router.route('/invoices/:documentId').get(requireWorkspaceCapability('invoices.read'), controller.getInvoice).all(methodNotAllowed);
router.route('/invoices/:documentId/issue').post(requireWorkspaceCapability('invoices.issue'), controller.issueInvoice).all(methodNotAllowed);
router.route('/invoices/:documentId/send').post(requireWorkspaceCapability('invoices.send'), controller.sendInvoice).all(methodNotAllowed);
router.route('/commercial-policy').get(requireWorkspaceCapability('commercial_policy.read'), controller.getPolicy).patch(requireWorkspaceCapability('commercial_policy.manage'), controller.updatePolicy).all(methodNotAllowed);
export default router;

export const publicCommercialDocumentRoutes = Router();
publicCommercialDocumentRoutes.route('/:token').get(controller.publicDocument).all(methodNotAllowed);
publicCommercialDocumentRoutes.route('/:token/decision').post(controller.acceptPublicQuote).all(methodNotAllowed);
