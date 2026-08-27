'use client';

import { createAuthClient } from 'better-auth/react';

import { clientEnv } from '@/lib/env.client';

/**
 * The browser half of Better Auth.
 *
 * Deliberately thin: the server owns every decision that matters — who is on
 * the allowlist, whether a session is still valid, what a password must look
 * like. This module only moves credentials to `/api/auth` and reads back the
 * session, so a compromised client cannot widen its own access.
 */
export const authClient = createAuthClient({
  baseURL: clientEnv.NEXT_PUBLIC_APP_URL,
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;

export type AuthSession = typeof authClient.$Infer.Session;
