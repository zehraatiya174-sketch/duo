import { auth } from '@/lib/auth';
import { isAuthorizedEmail } from '@/lib/auth/allowlist';
import { isVerifiedCookieHeader } from '@/lib/auth/verification';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import type { SocketAuthPayload } from '@/types/socket';

import type { DuoSocket } from './context';

const log = createLogger('socket:auth');

/**
 * Authenticates a socket handshake against the same session the HTTP layer
 * uses. There is no separate socket token: the browser's HttpOnly cookie is
 * forwarded with the upgrade request and validated by Better Auth, so a socket
 * can never outlive or out-scope the session that created it.
 */
export async function authenticateSocket(socket: DuoSocket): Promise<SocketAuthPayload | null> {
  const cookie = socket.handshake.headers.cookie;
  if (!cookie) return null;

  try {
    const headers = new Headers();
    headers.set('cookie', cookie);
    const userAgent = socket.handshake.headers['user-agent'];
    if (userAgent) headers.set('user-agent', userAgent);

    const session = await auth.api.getSession({ headers });
    if (!session?.user || !session.session) return null;

    // Re-check the allowlist here too: a session issued before the environment
    // changed must not be able to open a realtime channel.
    if (!isAuthorizedEmail(session.user.email)) {
      log.warn('Rejected socket for unauthorized address', { email: session.user.email });
      return null;
    }

    // The passphrase gate applies to the realtime channel too — otherwise a
    // session that never cleared it would still be handed live messages.
    if (!isVerifiedCookieHeader(session.user.id, cookie)) {
      log.warn('Rejected socket for unverified session', { userId: session.user.id });
      return null;
    }

    const profile = await db.profile.findUnique({
      where: { userId: session.user.id },
      select: { displayName: true },
    });

    return {
      userId: session.user.id,
      sessionId: session.session.id,
      email: session.user.email,
      displayName: profile?.displayName ?? session.user.name,
    };
  } catch (error) {
    log.error('Socket authentication threw', { error });
    return null;
  }
}

/**
 * Verifies that the session behind an already-connected socket still exists.
 * Run periodically so revoking a device also kills its realtime channel.
 */
export async function isSessionStillValid(sessionId: string): Promise<boolean> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: { expiresAt: true },
  });
  return Boolean(session && session.expiresAt > new Date());
}
