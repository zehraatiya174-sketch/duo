import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('devices');

interface SessionLike {
  id: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Turns a raw user-agent into something a person can recognise in a list of
 * their own logins.
 *
 * Deliberately crude. This is a memory aid — "was that me, on my phone,
 * yesterday?" — not analytics, and a wrong guess costs nothing. Order matters:
 * Edge and Chromium both claim to be Chrome, so the more specific tokens are
 * tested first.
 */
function describe(userAgent: string | null | undefined): {
  label: string;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
} {
  if (!userAgent) {
    return { label: 'Unknown device', browser: null, os: null, deviceType: null };
  }

  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\/|Opera/.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : null;

  const os =
    /Windows NT/.test(userAgent) ? 'Windows'
    : /iPhone|iPad|iPod/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : null;

  const deviceType =
    /iPad|Tablet/.test(userAgent) ? 'tablet'
    : /Mobi|iPhone|Android/.test(userAgent) ? 'mobile'
    : 'desktop';

  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'Unknown device');

  return { label, browser, os, deviceType };
}

/**
 * Records the device behind a new session so the user can audit and revoke it.
 *
 * Keyed on `sessionId`, which is unique — signing in again from the same
 * browser produces a new session and therefore a new row, which is correct:
 * revoking one login should not revoke the others.
 *
 * Never throws. This runs inside Better Auth's `session.create.after` hook, and
 * a failure to write an audit row must not stop someone signing in.
 */
export async function recordDeviceForSession(session: SessionLike): Promise<void> {
  try {
    const { label, browser, os, deviceType } = describe(session.userAgent);

    await db.device.upsert({
      where: { sessionId: session.id },
      update: { lastActiveAt: new Date() },
      create: {
        userId: session.userId,
        sessionId: session.id,
        label,
        browser,
        os,
        deviceType,
        ipAddress: session.ipAddress ?? null,
      },
    });
  } catch (error) {
    log.warn('Could not record the device for a session', { sessionId: session.id, error });
  }
}

/**
 * Drops expired sessions and the device rows that pointed at them.
 *
 * Run hourly by the socket server's maintenance timer. Sessions last an hour,
 * so without this the table grows by one row per sign-in forever and the
 * device list fills with logins that ended weeks ago.
 *
 * Devices are deleted separately rather than by cascade: `Device.sessionId` is
 * `SetNull` on delete, which would otherwise leave a detached row behind for
 * every expired session.
 */
export async function pruneExpiredSessions(): Promise<number> {
  const now = new Date();

  const expired = await db.session.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true },
  });

  if (expired.length === 0) return 0;

  const ids = expired.map((session) => session.id);

  await db.device.deleteMany({ where: { sessionId: { in: ids } } });
  const { count } = await db.session.deleteMany({ where: { id: { in: ids } } });

  return count;
}
