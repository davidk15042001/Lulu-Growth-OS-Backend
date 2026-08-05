import { Router } from 'express';
import * as controller from './auth.controller.js';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';

const router = Router();

router.route('/register')
  .post(controller.register)
  .all(methodNotAllowed);

router.route('/verify-otp')
  .post(controller.verifyOtp)
  .all(methodNotAllowed);

router.route('/login')
  .post(controller.login)
  .all(methodNotAllowed);

router.route('/refresh')
  .post(controller.refresh)
  .all(methodNotAllowed);

router.route('/logout')
  .post(controller.logout)
  .all(methodNotAllowed);

router.route('/logout-all')
  .post(requireAuth, controller.logoutAll)
  .all(methodNotAllowed);

router.route('/forgot-password')
  .post(controller.forgotPassword)
  .all(methodNotAllowed);

router.route('/resend-otp')
  .post(controller.resendOtp)
  .all(methodNotAllowed);

router.route('/reset-password')
  .post(controller.resetPassword)
  .all(methodNotAllowed);

export default router;
