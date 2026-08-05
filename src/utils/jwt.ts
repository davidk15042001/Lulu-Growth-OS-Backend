import jwt, { type Secret } from 'jsonwebtoken';
import { env } from '../config/env.js';

export type JwtPayload = {
  sub: string;
  email: string;
  tv?: number;
  role?: 'user' | 'admin';
};

export function signToken(payload: JwtPayload, expiresIn: string | number = '24h') {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyToken<T = JwtPayload>(token: string): T {
  return jwt.verify(token, env.JWT_SECRET as Secret) as T;
}

export function extractBearerToken(authorizationHeader?: string): string | null {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  return authorizationHeader.slice(7).trim() || null;
}
