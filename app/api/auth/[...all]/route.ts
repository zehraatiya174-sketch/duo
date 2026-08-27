import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

/**
 * Better Auth mounts its entire surface (sign-in, sign-up, OAuth callbacks,
 * session, password reset) under this catch-all.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
