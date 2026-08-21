import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './translation.controller.js';

const router = Router();

router.route('/').post(controller.translate).all(methodNotAllowed);

export default router;
