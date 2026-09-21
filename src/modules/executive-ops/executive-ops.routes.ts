import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './executive-ops.controller.js';

const router = Router({ mergeParams: true });
const read = requireWorkspaceCapability('agents.read', { enforceWriteEntitlement: false });
const manage = requireWorkspaceCapability('agents.manage');

router.route('/overview').get(read, controller.overview).all(methodNotAllowed);
router.route('/cycles').get(read, controller.cycles).all(methodNotAllowed);
router.route('/cycles/run').post(manage, controller.runCycle).all(methodNotAllowed);
router.route('/cycles/:cycleId').get(read, controller.cycleDetail).all(methodNotAllowed);
router.route('/findings').get(read, controller.findings).all(methodNotAllowed);
router.route('/forecasts').get(read, controller.forecasts).all(methodNotAllowed);
router.route('/schedules').get(read, controller.schedules).all(methodNotAllowed);
router.route('/schedules/:cycleType').put(manage, controller.saveSchedule).all(methodNotAllowed);
router.route('/scenarios').get(read, controller.scenarios).post(manage, controller.createScenario).all(methodNotAllowed);
router.route('/scenarios/:scenarioId').get(read, controller.scenarioDetail).all(methodNotAllowed);
router.route('/proposals').get(read, controller.proposals).post(manage, controller.createProposal).all(methodNotAllowed);
router.route('/proposals/:proposalId').get(read, controller.proposalDetail).all(methodNotAllowed);
router.route('/proposals/:proposalId/decision').post(manage, controller.decideProposal).all(methodNotAllowed);
router.route('/proposals/:proposalId/outcome').post(manage, controller.verifyProposalOutcome).all(methodNotAllowed);

export default router;
