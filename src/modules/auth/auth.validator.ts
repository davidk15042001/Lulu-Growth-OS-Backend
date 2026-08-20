import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
});

export const verifyOtpSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  code: z.string().length(6),
});

export const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refresh_token: z.string().optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});

export const resetPasswordSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  code: z.string().length(6),
  password: z.string().min(12).max(128),
});

export const resendOtpSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  purpose: z.enum(['verify', 'password_reset']),
});

export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');
