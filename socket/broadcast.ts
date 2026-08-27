import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { serializeMessage } from '@/lib/serializers/message';
import { truncate } from '@/lib/utils';
import {
  hydrateLinkPreviews,
  reloadMessage,
  type CreateMessageResult,
  type DeleteResult,
  type MutationResult,
  type ReactionResult,
} from '@/services/messages';
import { stripMarkdown } from '@/utils/text';
import { SOCKET_ROOMS } from '@/types/socket';

import type { DuoServer } from './context';

const log = createLogger('socket:broadcast');

interface BroadcastOptions {
  io: DuoServer;
  /**
   * The sender's own socket, which already has the authoritative row from its
   * acknowledgement. Excluding it prevents the bubble being replaced twice.
   */
  exceptSocketId?: string;
}

/**
 * Sends each recipient their own projection of a message.
 *
 * Per-viewer serialisation is not an optimisation to remove: ephemeral state is
 * relative to the person looking. A single shared payload would have to contain
 * either the sealed or the revealed form, and whichever it was would be wrong
 * for somebody — the sealed body leaking to a viewer who has not opened it is
 * exactly the failure this whole feature exists to prevent.
 */
function emitPerViewer(
  options: BroadcastOptions,
  entries: Array<{ userId: string; message: unknown }>,
  event: 'message:new' | 'message:updated',
): void {
  for (const entry of entries) {
    const room = options.io.to(SOCKET_ROOMS.user(entry.userId));
    const target = options.exceptSocketId ? room.except(options.exceptSocketId) : room;
    // The projection is built by `serializeMessage`, whose return type is the
    // DTO; the union above only exists so both result shapes fit one helper.
    target.emit(event, entry.message as never);
  }
}

export function broadcastMessageCreated(
  result: CreateMessageResult,
  authorId: string,
  options: BroadcastOptions,
): void {
  emitPerViewer(options, result.forRecipients, 'message:new');

  // The author's other devices need it too — they have no optimistic copy.
  options.io
    .to(SOCKET_ROOMS.user(authorId))
    .except(options.exceptSocketId ?? '')
    .emit('message:new', result.message);
}

export function broadcastMessageUpdated(
  result: MutationResult,
  authorId: string,
  options: BroadcastOptions,
): void {
  emitPerViewer(options, result.forRecipients, 'message:updated');

  options.io
    .to(SOCKET_ROOMS.user(authorId))
    .except(options.exceptSocketId ?? '')
    .emit('message:updated', result.message);
}

/**
 * A deletion carries no content, so it goes to the room rather than per viewer.
 * "Delete for me" is scoped to the actor's own devices.
 */
export function broadcastMessageDeleted(
  result: DeleteResult,
  actorId: string,
  options: BroadcastOptions,
): void {
  const payload = {
    messageId: result.messageId,
    chatId: result.chatId,
    scope: result.scope,
  };

  if (result.scope === 'me') {
    options.io.to(SOCKET_ROOMS.user(actorId)).emit('message:deleted', payload);
    return;
  }

  options.io.to(SOCKET_ROOMS.chat(result.chatId)).emit('message:deleted', payload);
}

/** `reacted` differs per viewer, so this fans out rather than hitting the room. */
export function broadcastReaction(result: ReactionResult, options: BroadcastOptions): void {
  for (const viewer of result.forViewers) {
    options.io.to(SOCKET_ROOMS.user(viewer.userId)).emit('message:reaction', {
      messageId: result.messageId,
      chatId: result.chatId,
      reactions: viewer.reactions,
    });
  }
}

export function broadcastPinned(
  result: { messageId: string; chatId: string; pinned: boolean },
  options: BroadcastOptions,
): void {
  options.io.to(SOCKET_ROOMS.chat(result.chatId)).emit('message:pinned', {
    messageId: result.messageId,
    chatId: result.chatId,
    pinned: result.pinned,
  });
}

export interface NotificationFanOut {
  chatId: string;
  authorId: string;
  authorName: string;
  recipientIds: string[];
  body: string | null;
  hasAttachment: boolean;
  messageId: string;
  mentionedIds: string[];
}

/**
 * Writes a notification row per recipient and pushes it live.
 *
 * The preview is stripped of markdown and truncated rather than sent whole: a
 * notification is persisted and may surface on a lock screen, so it should
 * never carry more of a message than its first line. Sealed messages are
 * described, never quoted — `body` is null for those by the time it gets here.
 */
export async function fanOutMessageNotifications(input: NotificationFanOut): Promise<void> {
  const others = input.recipientIds.filter((id) => id !== input.authorId);
  if (others.length === 0) return;

  const preview = input.body
    ? truncate(stripMarkdown(input.body), 140)
    : input.hasAttachment
      ? 'Sent an attachment'
      : null;

  const mentioned = new Set(input.mentionedIds);

  try {
    const rows = await db.$transaction(
      others.map((userId) =>
        db.notification.create({
          data: {
            userId,
            kind: mentioned.has(userId) ? 'MENTION' : 'MESSAGE',
            title: input.authorName,
            body: preview,
            href: `/?message=${input.messageId}`,
          },
        }),
      ),
    );

    const io = (await import('./context')).getSocketServer();
    if (!io) return;

    for (const row of rows) {
      io.to(SOCKET_ROOMS.user(row.userId)).emit('notification:new', {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        href: row.href,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      });
    }
  } catch (error) {
    // A missing notification is a far smaller problem than a send that fails.
    log.warn('Notification fan-out failed', { messageId: input.messageId, error });
  }
}

/**
 * Fetches link previews after the message is already delivered.
 *
 * Deliberately not awaited by the caller: a remote server that takes ten
 * seconds to answer must not hold up a message that is otherwise ready. When
 * previews do land the message is re-serialised and pushed as an update.
 */
export function hydratePreviewsInBackground(
  messageId: string,
  body: string | null,
  viewerIds: string[],
  options: { io: DuoServer },
): void {
  void (async () => {
    try {
      const changed = await hydrateLinkPreviews(messageId, body);
      if (!changed) return;

      const row = await reloadMessage(messageId);
      if (!row) return;

      for (const viewerId of viewerIds) {
        options.io
          .to(SOCKET_ROOMS.user(viewerId))
          .emit('message:updated', serializeMessage(row, viewerId));
      }
    } catch (error) {
      log.warn('Link preview hydration failed', { messageId, error });
    }
  })();
}
