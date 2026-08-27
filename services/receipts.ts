import { db } from '@/lib/db';

import { assertChatMember } from './messages';

export interface ReceiptUpdate {
  chatId: string;
  messageIds: string[];
  userId: string;
  kind: 'delivered' | 'read';
  at: string;
  /** Who needs to be told — the authors of the affected messages. */
  notifyUserIds: string[];
  unreadCount: number;
}

/**
 * Marks messages as delivered to `userId`.
 *
 * Only ever moves forward: a receipt that is already set is left alone so a
 * reconnecting client replaying its queue cannot rewrite history.
 */
export async function markDelivered(
  userId: string,
  chatId: string,
  messageIds: string[],
): Promise<ReceiptUpdate | null> {
  await assertChatMember(chatId, userId);
  const now = new Date();

  const pending = await db.receipt.findMany({
    where: {
      userId,
      deliveredAt: null,
      messageId: { in: messageIds },
      message: { chatId },
    },
    select: { messageId: true, message: { select: { authorId: true } } },
  });

  if (pending.length === 0) return null;

  const affectedIds = pending.map((r) => r.messageId);

  await db.$transaction([
    db.receipt.updateMany({
      where: { userId, messageId: { in: affectedIds }, deliveredAt: null },
      data: { deliveredAt: now },
    }),
    db.message.updateMany({
      where: { id: { in: affectedIds }, status: 'SENT' },
      data: { status: 'DELIVERED' },
    }),
  ]);

  const member = await db.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { unreadCount: true },
  });

  return {
    chatId,
    messageIds: affectedIds,
    userId,
    kind: 'delivered',
    at: now.toISOString(),
    notifyUserIds: [...new Set(pending.map((r) => r.message.authorId))],
    unreadCount: member?.unreadCount ?? 0,
  };
}

/**
 * Marks messages as read and recomputes the unread badge.
 *
 * Respects the reader's `showReadReceipts` privacy setting: the receipt is
 * still recorded (the badge depends on it) but the author is not notified.
 */
export async function markRead(
  userId: string,
  chatId: string,
  messageIds: string[],
): Promise<ReceiptUpdate | null> {
  await assertChatMember(chatId, userId);
  const now = new Date();

  const pending = await db.receipt.findMany({
    where: {
      userId,
      readAt: null,
      messageId: { in: messageIds },
      message: { chatId },
    },
    select: {
      messageId: true,
      message: { select: { authorId: true, createdAt: true } },
    },
  });

  const affectedIds = pending.map((r) => r.messageId);

  const newest = pending.reduce<{ id: string; createdAt: Date } | null>((acc, row) => {
    if (!acc || row.message.createdAt > acc.createdAt) {
      return { id: row.messageId, createdAt: row.message.createdAt };
    }
    return acc;
  }, null);

  await db.$transaction(async (tx) => {
    if (affectedIds.length > 0) {
      await tx.receipt.updateMany({
        where: { userId, messageId: { in: affectedIds }, readAt: null },
        data: { readAt: now, deliveredAt: { set: now } },
      });
      await tx.message.updateMany({
        where: { id: { in: affectedIds } },
        data: { status: 'READ' },
      });
    }

    // Recompute rather than decrement — an authoritative count cannot drift.
    const remaining = await tx.receipt.count({
      where: { userId, readAt: null, message: { chatId, deletedForAll: false } },
    });

    await tx.chatMember.update({
      where: { chatId_userId: { chatId, userId } },
      data: {
        unreadCount: remaining,
        lastReadAt: now,
        ...(newest ? { lastReadMessageId: newest.id } : {}),
      },
    });
  });

  if (affectedIds.length === 0) return null;

  const reader = await db.profile.findUnique({
    where: { userId },
    select: { showReadReceipts: true },
  });

  const member = await db.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { unreadCount: true },
  });

  return {
    chatId,
    messageIds: affectedIds,
    userId,
    kind: 'read',
    at: now.toISOString(),
    notifyUserIds:
      reader?.showReadReceipts === false
        ? []
        : [...new Set(pending.map((r) => r.message.authorId))],
    unreadCount: member?.unreadCount ?? 0,
  };
}

/** Marks every unread message in a conversation as read. */
export async function markChatRead(userId: string, chatId: string): Promise<ReceiptUpdate | null> {
  const unread = await db.receipt.findMany({
    where: { userId, readAt: null, message: { chatId } },
    select: { messageId: true },
    take: 500,
  });
  if (unread.length === 0) return null;
  return markRead(
    userId,
    chatId,
    unread.map((r) => r.messageId),
  );
}

export async function getUnreadCount(userId: string, chatId: string): Promise<number> {
  const member = await db.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { unreadCount: true },
  });
  return member?.unreadCount ?? 0;
}

/**
 * Delivers every outstanding message at once. Called when a socket connects,
 * which is the moment "delivered" actually becomes true.
 */
export async function flushPendingDeliveries(
  userId: string,
  chatId: string,
): Promise<ReceiptUpdate | null> {
  const pending = await db.receipt.findMany({
    where: { userId, deliveredAt: null, message: { chatId } },
    select: { messageId: true },
    take: 500,
  });
  if (pending.length === 0) return null;
  return markDelivered(
    userId,
    chatId,
    pending.map((r) => r.messageId),
  );
}
