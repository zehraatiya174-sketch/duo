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
/**
 * In the browser, the origin that served the page is the authority.
 *
 * `NEXT_PUBLIC_APP_URL` is inlined by `next build`, so it is only ever as
 * correct as the build argument that produced it. If that argument fails to
 * arrive — a misconfigured host, a Dockerfile default left in place — the
 * bundle ships pointing at `http://localhost:3000` and every sign-in silently
 * posts to nowhere. The server-side production guard cannot catch it either:
 * it reads the *runtime* value, which would be perfectly correct.
 *
 * This app is same-origin by construction, so `window.location.origin` is not
 * merely a safer default, it is the right answer. The env value remains the
 * fallback for server rendering, where there is no window.
 */
const baseURL =
  typeof window === 'undefined' ? clientEnv.NEXT_PUBLIC_APP_URL : window.location.origin;

export const authClient = createAuthClient({ baseURL });

export const { signIn, signUp, signOut, useSession, getSession } = authClient;

export type AuthSession = typeof authClient.$Infer.Session;
