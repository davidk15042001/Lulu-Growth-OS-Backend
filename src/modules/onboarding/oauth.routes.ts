import { Router } from 'express';
import * as controller from './onboarding.controller.js';

const router = Router();

router.get('/:provider/callback', controller.oauthCallback);

export default router;
