import type { Request, Response, NextFunction } from 'express';
import { isProd } from '../../config/env.js';
import * as service from './auth.service.js';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import {
  registerSchema,
  verifyOtpSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendOtpSchema
} from './auth.validator.js';

const RT_COOKIE_NAME = 'rt';
const RT_COOKIE_OPTS = { 
  httpOnly: true, 
  sameSite: isProd ? 'strict' as const : 'lax' as const, 
  secure: isProd, 
  maxAge: 30 * 24 * 60 * 60 * 1000, 
  path: '/' 
};

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const body = registerSchema.parse(req.body);
    const result = await service.registerUser(body.email, body.password, body.first_name, body.last_name);
    if ('conflict' in result) {
      return res.status(409).json({ error: 'Email already in use', errorMessage: 'Email already in use' });
    }
    
    if (!isProd && result.code) {
      return res.status(201).json({ success: true, message: 'Registered. Verify OTP to activate account.', otp: result.code });
    }
    
    return res.status(201).json({ success: true, message: 'Registered. Verify OTP to activate account.' });
  } catch (e) {
    next(e);
  }
}

export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const body = verifyOtpSchema.parse(req.body);
    const result = await service.verifyEmailOtp(body.email, body.code);
    
    if ('notFound' in result) return res.status(404).json({ error: 'User not found', errorMessage: 'Account not found' });
    if ('invalid' in result) return res.status(400).json({ error: 'Invalid code', errorMessage: 'Invalid verification code' });
    if ('used' in result) return res.status(400).json({ error: 'Code already used', errorMessage: 'Code already used' });
    if ('expired' in result) return res.status(400).json({ error: 'Code expired', errorMessage: 'Verification code expired' });
    
    return res.json({ success: true, message: 'Account verified' });
  } catch (e) {
    next(e);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const body = loginSchema.parse(req.body);
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const result = await service.loginUser(body.email, body.password, { userAgent, ipAddress: req.ip ?? null });
    
    if ('invalid' in result) return res.status(401).json({ error: 'Invalid credentials', errorMessage: 'Invalid email or password' });
    if ('unverified' in result) return res.status(403).json({ error: 'Account not verified', errorMessage: 'Verify your email to continue' });
    
    res.cookie(RT_COOKIE_NAME, result.refreshToken, RT_COOKIE_OPTS);
    
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
    if (!refreshToken) return res.status(401).json({ error: 'Missing token', errorMessage: 'Please sign in' });
    
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const result = await service.refreshAccessToken(refreshToken, { userAgent, ipAddress: req.ip ?? null });
    
    if ('invalid' in result) return res.status(401).json({ error: 'Invalid token', errorMessage: 'Please sign in' });
    if ('expired' in result) return res.status(401).json({ error: 'Expired token', errorMessage: 'Please sign in' });
    
    res.cookie(RT_COOKIE_NAME, result.refreshToken, RT_COOKIE_OPTS);
    
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
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', errorMessage: 'Please sign in' });
    
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
    
    if ('invalid' in result) return res.status(400).json({ error: 'Invalid code', errorMessage: 'Invalid reset code' });
    if ('expired' in result) return res.status(400).json({ error: 'Expired code', errorMessage: 'Reset code expired' });
    
    return res.json({ success: true, message: 'Password updated' });
  } catch (e) {
    next(e);
  }
}
