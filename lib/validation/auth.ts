import { z } from 'zod';

// Imported from the policy module, not `@/lib/auth/password`: these schemas are
// shared with client forms, and the hashing module pulls in a native addon.
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  assessPasswordStrength,
} from '@/lib/auth/password-policy';

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .email('Enter a valid email address')
  .max(254, 'Email is too long')
  .transform((value) => value.toLowerCase());

/** Enforces the same policy the server applies, so the form fails fast. */
export const strongPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
  .superRefine((value, ctx) => {
    for (const issue of assessPasswordStrength(value).issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
  rememberMe: z.boolean().default(true),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Enter your name')
      .max(60, 'Name is too long')
      .regex(/^[\p{L}\p{N} '._-]+$/u, 'Name contains unsupported characters'),
    email: emailSchema,
    password: strongPasswordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the terms to continue' }),
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * The post-login passphrase. Deliberately has no shape rules beyond a length
 * bound — the phrase is chosen by whoever deploys the app, and validating its
 * composition here would only leak what it looks like.
 */
export const verificationSchema = z.object({
  passphrase: z.string().min(1, 'Enter the passphrase').max(256, 'That is too long'),
});
export type VerificationInput = z.infer<typeof verificationSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Reset token is missing'),
    password: strongPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: strongPasswordSchema,
    confirmPassword: z.string(),
    revokeOtherSessions: z.boolean().default(true),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'Choose a password you have not used before',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
