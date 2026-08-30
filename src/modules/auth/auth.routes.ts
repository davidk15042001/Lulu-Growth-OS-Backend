import { Router } from 'express';
import type { Request } from 'express';
import crypto from 'node:crypto';
import * as controller from './auth.controller.js';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { dbRateLimit, otpLimiter } from '../../middlewares/rateLimit.middleware.js';

const router = Router();

const authLimitMessage = 'Too many authentication attempts. Please wait and try again.';
function emailIdentifier(req: Request) {
  const value = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof value !== 'string' || !value.trim()) return null;
  const digest = crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  return `email:${digest}`;
}

const registrationLimiter = dbRateLimit({ keyPrefix: 'auth-register', windowMs: 60 * 60 * 1000, limit: 10, message: authLimitMessage });
const loginIpLimiter = dbRateLimit({ keyPrefix: 'auth-login-ip', windowMs: 15 * 60 * 1000, limit: 30, message: authLimitMessage });
const loginAccountLimiter = dbRateLimit({ keyPrefix: 'auth-login-account', windowMs: 15 * 60 * 1000, limit: 20, message: authLimitMessage, identifier: emailIdentifier });
const refreshLimiter = dbRateLimit({ keyPrefix: 'auth-refresh', windowMs: 60 * 60 * 1000, limit: 120, message: authLimitMessage });
const passwordResetIpLimiter = dbRateLimit({ keyPrefix: 'auth-password-reset-ip', windowMs: 60 * 60 * 1000, limit: 10, message: authLimitMessage });
const passwordResetAccountLimiter = dbRateLimit({ keyPrefix: 'auth-password-reset-account', windowMs: 60 * 60 * 1000, limit: 5, message: authLimitMessage, identifier: emailIdentifier });

router.route('/register')
  .post(registrationLimiter, controller.register)
  .all(methodNotAllowed);

router.route('/verify-otp')
  .post(otpLimiter, controller.verifyOtp)
  .all(methodNotAllowed);

router.route('/login')
  .post(loginIpLimiter, loginAccountLimiter, controller.login)
  .all(methodNotAllowed);

router.route('/refresh')
  .post(refreshLimiter, controller.refresh)
  .all(methodNotAllowed);

router.route('/logout')
  .post(controller.logout)
  .all(methodNotAllowed);

router.route('/logout-all')
  .post(requireAuth, controller.logoutAll)
  .all(methodNotAllowed);

router.route('/forgot-password')
  .post(passwordResetIpLimiter, passwordResetAccountLimiter, controller.forgotPassword)
  .all(methodNotAllowed);

router.route('/resend-otp')
  .post(otpLimiter, controller.resendOtp)
  .all(methodNotAllowed);

router.route('/reset-password')
  .post(otpLimiter, controller.resetPassword)
  .all(methodNotAllowed);

router.route('/me')
  .get(requireAuth, controller.me)
  .patch(requireAuth, controller.updateMe)
  .all(methodNotAllowed);

export default router;
