import type { Request, Response, NextFunction } from 'express';
import { env, isProd } from '../../config/env.js';
import * as service from './auth.service.js';
import * as repo from './auth.repo.js';
import { z } from 'zod';
import { getAdminCapabilities } from '../admin/admin.authorization.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { jsonError } from '../../utils/response.js';
import {
  registerSchema,
  verifyOtpSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendOtpSchema,
  updateProfileSchema,
} from './auth.validator.js';

const RT_COOKIE_NAME = 'rt';
const refreshCookieSameSite = env.REFRESH_COOKIE_SAME_SITE ?? (isProd ? 'none' : 'lax');
export const RT_COOKIE_OPTS = {
  httpOnly: true, 
  sameSite: refreshCookieSameSite,
  secure: isProd, 
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  path: '/' 
};

export function setRefreshTokenCookie(res: Response, refreshToken: string) {
  res.cookie(RT_COOKIE_NAME, refreshToken, RT_COOKIE_OPTS);
}

function sessionUserResponse(
  user: { id: string; email: string; first_name?: string | null; last_name?: string | null; firstName?: string | null; lastName?: string | null; role: 'user' | 'admin' },
  impersonator?: { email: string } | null,
) {
  return {
    id: user.id,
    email: user.email,
    firstName: ('first_name' in user ? user.first_name : user.firstName) ?? null,
    lastName: ('last_name' in user ? user.last_name : user.lastName) ?? null,
    role: user.role,
    impersonation: {
      active: Boolean(impersonator),
      adminEmail: impersonator?.email ?? null,
    },
  };
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const body = registerSchema.parse(req.body);
    const result = await service.registerUser(body.email, body.password, body.first_name, body.last_name);
    if ('conflict' in result) {
      return jsonError(res, 409, 'EMAIL_IN_USE', 'Email already in use');
    }
    
    return res.status(201).json({ success: true, message: 'Verify your email to continue.', data: { verificationRequired:true, verificationSent:result.verificationSent } });
  } catch (e) {
    next(e);
  }
}

export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const body = verifyOtpSchema.parse(req.body);
    const result = await service.verifyEmailOtp(body.email, body.code);
    
    if ('invalid' in result) return jsonError(res, 400, 'INVALID_OTP', 'Invalid verification code');
    if ('used' in result) return jsonError(res, 400, 'OTP_USED', 'Code already used');
    if ('expired' in result) return jsonError(res, 400, 'OTP_EXPIRED', 'Verification code expired');
    
    return res.json({ success: true, message: 'alreadyVerified' in result ? 'Account already verified' : 'Account verified', data:{alreadyVerified:'alreadyVerified' in result} });
  } catch (e) {
    next(e);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const body = loginSchema.parse(req.body);
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const result = await service.loginUser(body.email, body.password, { userAgent, ipAddress: req.ip ?? null });
    
    if ('invalid' in result) return jsonError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    if ('unverified' in result) return jsonError(res, 403, 'ACCOUNT_UNVERIFIED', 'Verify your email to continue');
    
    setRefreshTokenCookie(res, result.refreshToken);
    
    return res.json({ 
      success: true, 
      message: 'Logged in', 
      data: { 
        token: result.token, 
        user: result.user 
      } 
    });
  } catch (e) {
    next(e);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const body = refreshSchema.parse(req.body);
    const refreshToken = body.refresh_token || (req.cookies?.[RT_COOKIE_NAME] as string);
    if (!refreshToken) return jsonError(res, 401, 'MISSING_REFRESH_TOKEN', 'Please sign in');
    
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const result = await service.refreshAccessToken(refreshToken, { userAgent, ipAddress: req.ip ?? null });
    
    if ('invalid' in result) return jsonError(res, 401, 'INVALID_REFRESH_TOKEN', 'Please sign in');
    if ('expired' in result) return jsonError(res, 401, 'REFRESH_TOKEN_EXPIRED', 'Please sign in');
    if ('reused' in result) { res.clearCookie(RT_COOKIE_NAME,RT_COOKIE_OPTS); return jsonError(res,401,'REFRESH_REUSE_DETECTED','This session was revoked. Please sign in again'); }
    
    setRefreshTokenCookie(res, result.refreshToken);
    
    return res.json({ 
      success: true, 
      message: 'Token refreshed', 
      data: { 
        token: result.token, 
        user: result.user 
      } 
    });
  } catch (e) {
    next(e);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const refreshToken = req.cookies?.[RT_COOKIE_NAME] as string;
    await service.logout(refreshToken);
    res.clearCookie(RT_COOKIE_NAME, RT_COOKIE_OPTS);
    return res.json({ success: true, message: 'Logged out' });
  } catch (e) {
    next(e);
  }
}

export async function logoutAll(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if(req.impersonator) return jsonError(res,403,'FORBIDDEN','End impersonation to manage sessions');
    const userId = req.user?.id;
    if (!userId) return jsonError(res, 401, 'UNAUTHORIZED', 'Please sign in');
    
    await service.logoutAll(userId);
    res.clearCookie(RT_COOKIE_NAME, RT_COOKIE_OPTS);
    return res.json({ success: true, message: 'Logged out from all devices' });
  } catch (e) {
    next(e);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const body = forgotPasswordSchema.parse(req.body);
    await service.createPasswordResetOtp(body.email);
    return res.json({ success: true, message: 'If the email exists, a reset code has been sent' });
  } catch (e) {
    next(e);
  }
}

export async function resendOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const body = resendOtpSchema.parse(req.body);
    const result = await service.resendOtp(body.email, body.purpose);
    
    if ('alreadyVerified' in result) return res.json({ success: true, message: 'Account already verified' });
    return res.json({ success: true, message: 'OTP re-sent if account exists' });
  } catch (e) {
    next(e);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const body = resetPasswordSchema.parse(req.body);
    const result = await service.resetPasswordWithOtp(body.email, body.code, body.password);
    
    if ('invalid' in result) return jsonError(res, 400, 'INVALID_RESET_CODE', 'Invalid reset code');
    if ('expired' in result) return jsonError(res, 400, 'RESET_CODE_EXPIRED', 'Reset code expired');
    
    return res.json({ success: true, message: 'Password updated' });
  } catch (e) {
    next(e);
  }
}

export async function me(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await service.getCurrentUser(req.user!.id);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    return res.json({
      success: true,
      data: { ...sessionUserResponse(user, req.impersonator), adminCapabilities:req.impersonator?[]:await getAdminCapabilities(user.id) },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateMe(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const input = updateProfileSchema.parse(req.body);
    const user = await service.updateCurrentUser(req.user!.id, input);
    return res.json({
      success: true,
      message: 'Profile updated',
      data: user ? {...sessionUserResponse(user, req.impersonator),adminCapabilities:req.impersonator?[]:await getAdminCapabilities(user.id)} : null,
    });
  } catch (error) {
    next(error);
  }
}

export async function stopImpersonation(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.impersonator) {
      return jsonError(res, 409, 'IMPERSONATION_NOT_ACTIVE', 'No impersonated admin session is active');
    }

    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const result = await service.stopImpersonation(
      { userId: req.impersonator.id, email: req.impersonator.email },
      { userAgent, ipAddress: req.ip ?? null },
    );
    if ('invalid' in result) return jsonError(res, 403, 'FORBIDDEN', 'The impersonated session can no longer be restored');

    await repo.revokeSession(req.user!.id,req.sessionId!);
    await recordSecurityEvent({eventType:'ADMIN_ACTION',userId:req.impersonator.id,metadata:{action:'impersonation.stop',targetId:req.user!.id}});

    setRefreshTokenCookie(res, result.refreshToken);
    return res.json({
      success: true,
      message: 'Impersonation ended',
      data: {
        token: result.token,
        user: result.user,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function sessions(req:AuthedRequest,res:Response,next:NextFunction) {
  try { return res.json({success:true,data:{items:await repo.listSessions(req.user!.id,req.sessionId!)}}); } catch(error){next(error);}
}
export async function revokeSession(req:AuthedRequest,res:Response,next:NextFunction) {
  try {
    const id=z.string().uuid().parse(req.params.sessionId);
    if(req.impersonator) return jsonError(res,403,'FORBIDDEN','End impersonation to manage sessions');
    await repo.revokeSession(req.user!.id,id);
    if(id===req.sessionId) res.clearCookie(RT_COOKIE_NAME,RT_COOKIE_OPTS);
    return res.json({success:true,data:{revoked:true}});
  } catch(error){next(error);}
}
export async function revokeOtherSessions(req:AuthedRequest,res:Response,next:NextFunction) {
  try {
    if(req.impersonator) return jsonError(res,403,'FORBIDDEN','End impersonation to manage sessions');
    return res.json({success:true,data:{revoked:await repo.revokeSessions(req.user!.id,req.sessionId!)}});
  } catch(error){next(error);}
}
