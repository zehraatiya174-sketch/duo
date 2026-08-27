import { toAppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  deleteMessageSchema,
  editMessageSchema,
  reactionSchema,
  receiptSchema,
  sendMessageSchema,
} from '@/lib/validation/message';
import {
  createMessage,
  deleteMessage,
  editMessage,
  messagesSince,
  setPinned,
  toggleReaction,
} from '@/services/messages';
import { markDelivered, markRead } from '@/services/receipts';
import { SOCKET_ROOMS } from '@/types/socket';

import {
  broadcastMessageCreated,
  broadcastMessageDeleted,
  broadcastMessageUpdated,
  broadcastPinned,
  broadcastReaction,
  fanOutMessageNotifications,
  hydratePreviewsInBackground,
} from '../broadcast';
import type { DuoServer, DuoSocket } from '../context';
import { setTyping } from '../presence';
import { ack, guard } from './shared';

const log = createLogger('socket:messages');

export function registerMessageHandlers(io: DuoServer, socket: DuoSocket): void {
  const { userId, displayName } = socket.data.auth;

  // --- send ---------------------------------------------------------------
  socket.on(
    'message:send',
    guard(socket, 'message:send', async (raw, respond) => {
      const input = sendMessageSchema.parse(raw);
      const result = await createMessage(userId, input);

      // The sending socket gets the authoritative row through the ack so it can
      // reconcile its optimistic bubble; everyone else is served by the fan-out,
      // which serializes per-viewer because ephemeral gating differs by user.
      respond(ack.ok(result.message));
      if (result.deduplicated) return;

      broadcastMessageCreated(result, userId, { io, exceptSocketId: socket.id });

      await fanOutMessageNotifications({
        chatId: input.chatId,
        authorId: userId,
        authorName: displayName,
        recipientIds: result.recipientIds,
        body: result.row.body,
        hasAttachment: result.row.attachments.length > 0,
        messageId: result.row.id,
        mentionedIds: (input.mentions ?? []).map((mention) => mention.userId),
      });

      hydratePreviewsInBackground(
        result.row.id,
        result.row.body,
        [userId, ...result.recipientIds],
        {
          io,
        },
      );
    }),
  );

  // --- edit ---------------------------------------------------------------
  socket.on(
    'message:edit',
    guard(socket, 'message:edit', async (raw, respond) => {
      const input = editMessageSchema.parse(raw);
      const result = await editMessage(userId, input);

      respond(ack.ok(result.message));
      broadcastMessageUpdated(result, userId, { io, exceptSocketId: socket.id });

      hydratePreviewsInBackground(
        result.row.id,
        result.row.body,
        [userId, ...result.recipientIds],
        {
          io,
        },
      );
    }),
  );

  // --- delete -------------------------------------------------------------
  socket.on(
    'message:delete',
    guard(socket, 'message:delete', async (raw, respond) => {
      const input = deleteMessageSchema.parse(raw);
      const result = await deleteMessage(userId, input);

      respond(ack.ok({ messageId: result.messageId }));
      broadcastMessageDeleted(result, userId, { io });
    }),
  );

  // --- reactions ----------------------------------------------------------
  socket.on(
    'message:react',
    guard(socket, 'message:react', async (raw, respond) => {
      const input = reactionSchema.parse(raw);
      const result = await toggleReaction(userId, input);

      respond(ack.ok({ messageId: result.messageId, reactions: result.reactions }));
      broadcastReaction(result, { io });
    }),
  );

  // --- pin ----------------------------------------------------------------
  socket.on(
    'message:pin',
    guard(socket, 'message:pin', async (raw, respond) => {
      const result = await setPinned(userId, String(raw.messageId), Boolean(raw.pinned));
      respond(ack.ok({ messageId: result.messageId, pinned: result.pinned }));
      broadcastPinned(result, { io });
    }),
  );

  // --- typing -------------------------------------------------------------
  socket.on('typing:set', (payload) => {
    if (!payload?.chatId || !socket.data.chats.has(payload.chatId)) return;
    setTyping(io, userId, payload.chatId, Boolean(payload.typing));
  });

  // --- receipts -----------------------------------------------------------
  socket.on('receipt:delivered', (raw) => {
    void (async () => {
      try {
        const input = receiptSchema.parse(raw);
        const update = await markDelivered(userId, input.chatId, input.messageIds);
        if (!update) return;
        for (const authorId of update.notifyUserIds) {
          io.to(SOCKET_ROOMS.user(authorId)).emit('receipt:update', {
            chatId: update.chatId,
            messageIds: update.messageIds,
            userId,
            kind: 'delivered',
            at: update.at,
          });
        }
      } catch (error) {
        log.debug('Delivered receipt failed', { error });
      }
    })();
  });

  socket.on('receipt:read', (raw, respond) => {
    void (async () => {
      try {
        const input = receiptSchema.parse(raw);
        const update = await markRead(userId, input.chatId, input.messageIds);
        respond?.(ack.ok({ unreadCount: update?.unreadCount ?? 0 }));
        if (!update) return;

        io.to(SOCKET_ROOMS.user(userId)).emit('unread:update', {
          chatId: update.chatId,
          unreadCount: update.unreadCount,
        });

        for (const authorId of update.notifyUserIds) {
          io.to(SOCKET_ROOMS.user(authorId)).emit('receipt:update', {
            chatId: update.chatId,
            messageIds: update.messageIds,
            userId,
            kind: 'read',
            at: update.at,
          });
        }
      } catch (error) {
        const appError = toAppError(error);
        respond?.(ack.fail(appError.code, appError.message));
      }
    })();
  });

  // --- reconnect sync -----------------------------------------------------
  socket.on(
    'sync:since',
    guard(socket, 'sync:since', async (raw, respond) => {
      const since = new Date(String(raw.since));
      if (Number.isNaN(since.getTime())) {
        respond(ack.fail('BAD_REQUEST', 'Invalid `since` timestamp'));
        return;
      }
      const messages = await messagesSince(userId, String(raw.chatId), since);
      respond(ack.ok({ messages }));
    }),
  );
}
