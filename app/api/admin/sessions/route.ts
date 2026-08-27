import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, readJson } from '@/lib/api/respond';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { listActiveSessions, type AdminSessionRow } from '@/services/admin';
import { getSocketServer } from '@/socket/context';
import { SOCKET_ROOMS } from '@/types/socket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('admin:sessions');

const revokeSchema = z.object({ sessionId: z.string().min(1) });

export const GET = adminRoute<Record<string, never>, AdminSessionRow[]>(async () => {
  return NextResponse.json<AdminSessionRow[]>(await listActiveSessions());
});

/**
 * Force-ends a session.
 *
 * Deleting the row is what actually revokes it — every request re-reads the
 * session, and the socket server re-validates open connections every five
 * minutes. The disconnect below is the courtesy: it closes the realtime channel
 * immediately instead of leaving the device connected until that sweep runs.
 */
export const DELETE = adminRoute<Record<string, never>, { revoked: true }>(
  async ({ request, user }) => {
    const { sessionId } = revokeSchema.parse(await readJson(request));

    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });
    if (!session) throw notFound('That session no longer exists');

    await db.device.deleteMany({ where: { sessionId } });
    await db.session.delete({ where: { id: sessionId } });

    // `DEVICE_REVOKED` rather than a session-specific verb: the enum models
    // this as revoking the device the session belonged to, and the device row
    // is deleted alongside it above.
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'DEVICE_REVOKED',
        metadata: { sessionId, targetUserId: session.userId },
      },
    });

    const io = getSocketServer();
    if (io) {
      for (const [, socket] of io.sockets.sockets) {
        if (socket.data.auth?.sessionId !== sessionId) continue;
        socket.emit('session:revoked', { reason: 'An administrator signed this device out' });
        socket.disconnect(true);
      }
      io.to(SOCKET_ROOMS.user(session.userId)).emit('unread:update', {
        chatId: '',
        unreadCount: 0,
      });
    }

    log.info('Session revoked', { sessionId, by: user.id });

    return NextResponse.json({ revoked: true as const });
  },
);
