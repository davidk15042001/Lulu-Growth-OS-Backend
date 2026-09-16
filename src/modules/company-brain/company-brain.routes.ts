import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './company-brain.controller.js';

const router = Router({ mergeParams: true });
const read = requireWorkspaceCapability('agents.read', { enforceWriteEntitlement: false });
const manage = requireWorkspaceCapability('agents.manage');

router.route('/overview').get(read, controller.overview).all(methodNotAllowed);
router.route('/signals').get(read, controller.signals).all(methodNotAllowed);
router.route('/missions').get(read, controller.missions).post(manage, controller.createMission).all(methodNotAllowed);
router.route('/missions/:missionId').patch(manage, controller.updateMission).all(methodNotAllowed);
router.route('/missions/:missionId/graph').get(read, controller.missionGraph).all(methodNotAllowed);
router.route('/missions/:missionId/tasks').get(read, controller.missionTasks).post(manage, controller.createTask).all(methodNotAllowed);
router.route('/tasks/:taskId').get(read, controller.taskDetail).patch(manage, controller.updateTask).all(methodNotAllowed);
router.route('/tasks/:taskId/dependencies').post(manage, controller.addTaskDependency).all(methodNotAllowed);
router.route('/decisions').get(read, controller.decisions).post(manage, controller.createDecision).all(methodNotAllowed);
router.route('/learning').get(read, controller.learning).post(manage, controller.createLearning).all(methodNotAllowed);

export default router;
