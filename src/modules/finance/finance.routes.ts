import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import * as controller from './finance.controller.js';
import payoutRoutes from './payout.routes.js';
import { registerInvoiceJournalProjection } from './invoice-journal.projection.js';

registerInvoiceJournalProjection();

const router=Router({mergeParams:true});
router.route('/journals').get(requireWorkspaceCapability('finance.read'),controller.listJournals).all(methodNotAllowed);
router.route('/journals/:journalId').get(requireWorkspaceCapability('finance.read'),controller.getJournal).all(methodNotAllowed);
router.route('/accounts/:accountCode/balance').get(requireWorkspaceCapability('finance.read'),controller.getAccountBalance).all(methodNotAllowed);
router.route('/trial-balance').get(requireWorkspaceCapability('finance.read'),controller.getTrialBalance).all(methodNotAllowed);
router.use(payoutRoutes);
export default router;
