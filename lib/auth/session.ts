import { cache } from 'react';

import { headers } from 'next/headers';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { forbidden, unauthorized } from '@/lib/errors';

import { isAdminEmail, isAuthorizedEmail } from './allowlist';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: 'ADMIN' | 'MEMBER';
  isAdmin: boolean;
  sessionId: string;
  profile: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    statusText: string | null;
    showLastSeen: boolean;
    showReadReceipts: boolean;
  } | null;
}

/**
 * Reads the current session. Wrapped in React's `cache` so that a single
 * request resolves it exactly once no matter how many layouts, pages and
 * server components ask for it.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user || !session.session) return null;

  // Re-verify against the allowlist on every request. A session issued before
  // the environment changed must stop working immediately.
  if (!isAuthorizedEmail(session.user.email)) return null;

  const profile = await db.profile.findUnique({
    where: { userId: session.user.id },
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      statusText: true,
      showLastSeen: true,
      showReadReceipts: true,
    },
  });

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image ?? null,
    role: isAdminEmail(session.user.email) ? 'ADMIN' : 'MEMBER',
    isAdmin: isAdminEmail(session.user.email),
    sessionId: session.session.id,
    profile,
  };
});

/** Throws 401 when unauthenticated. Use in route handlers and server actions. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  return user;
}

/** Throws 403 unless the caller is the configured admin. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw forbidden('Administrator access required');
  return user;
}
