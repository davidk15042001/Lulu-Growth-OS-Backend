import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { oauthCallback } from './email.controller.js';
const router = Router();
router.route('/oauth/:provider/callback').get(oauthCallback).all(methodNotAllowed);
export default router;
