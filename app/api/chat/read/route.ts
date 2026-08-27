import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authedRoute, readJson } from '@/lib/api/respond';
import { markChatRead, markRead } from '@/services/receipts';
import { getSocketServer } from '@/socket/context';
import { SOCKET_ROOMS } from '@/types/socket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const readSchema = z.object({
  chatId: z.string().cuid(),
  /** Omit to mark the entire conversation read. */
  messageIds: z.array(z.string().cuid()).max(500).optional(),
});

interface ReadBody {
  unreadCount: number;
}

/**
 * HTTP fallback for read receipts, used when the socket is down. The socket
 * path is the normal one; this keeps unread counts correct offline-to-online.
 */
export const POST = authedRoute<Record<string, never>, ReadBody>(async ({ request, user }) => {
  const input = readSchema.parse(await readJson(request));

  const update = input.messageIds?.length
    ? await markRead(user.id, input.chatId, input.messageIds)
    : await markChatRead(user.id, input.chatId);

  if (update) {
    const io = getSocketServer();
    if (io) {
      io.to(SOCKET_ROOMS.user(user.id)).emit('unread:update', {
        chatId: update.chatId,
        unreadCount: update.unreadCount,
      });
      for (const authorId of update.notifyUserIds) {
        io.to(SOCKET_ROOMS.user(authorId)).emit('receipt:update', {
          chatId: update.chatId,
          messageIds: update.messageIds,
          userId: user.id,
          kind: 'read',
          at: update.at,
        });
      }
    }
  }

  return NextResponse.json<ReadBody>({ unreadCount: update?.unreadCount ?? 0 });
});
