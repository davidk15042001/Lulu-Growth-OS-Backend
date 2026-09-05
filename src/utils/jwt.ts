import jwt, { type Secret } from 'jsonwebtoken';
import { env } from '../config/env.js';

export type JwtPayload = {
  sub: string;
  email: string;
  tv?: number;
  sid?: string;
  role?: 'user' | 'admin';
  impersonatorUserId?: string;
  impersonatorEmail?: string;
};

export function signToken(payload: JwtPayload, expiresIn: string | number = env.ACCESS_TOKEN_TTL) {
  // Clamp legacy configuration as well as the new default to at most one hour.
  const match = typeof expiresIn === 'string' ? /^(\d+)(s|m|h|d)$/.exec(expiresIn) : null;
  const seconds = typeof expiresIn === 'number' ? expiresIn : match ? Number(match[1]) * ({s:1,m:60,h:3600,d:86400}[match[2]!] ?? 1) : 900;
  return jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: Math.max(60,Math.min(seconds,3600)) });
}

export function verifyToken<T = JwtPayload>(token: string): T {
  return jwt.verify(token, env.JWT_SECRET as Secret, { algorithms: ['HS256'] }) as T;
}

export function extractBearerToken(authorizationHeader?: string): string | null {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  return authorizationHeader.slice(7).trim() || null;
}
