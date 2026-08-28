// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaMock, resetPrismaMock } from '../helpers/prisma-mock';

/**
 * Deleting a message.
 *
 * "Delete for everyone" used to expire an hour after sending, which meant an
 * old photo or video could not be taken back — and, because the blobs are
 * purged along with the message, could not be reclaimed from storage either.
 * That rule is borrowed from messengers where it protects a recipient from a
 * stranger rewriting history; here there are two people who know each other.
 *
 * What these tests pin is that removing the expiry did not take the two real
 * guarantees with it: only the author may withdraw their own message, and the
 * act is still recorded even though the content is gone.
 */

const prisma = createPrismaMock();
vi.mock('@/lib/db', () => ({ db: prisma }));

const purgeAttachmentsForMessage = vi.fn(async () => 1);
vi.mock('@/services/storage', () => ({ purgeAttachmentsForMessage }));

const { deleteMessage } = await import('@/services/messages');

const AUTHOR = 'user-author';
const OTHER = 'user-other';
const CHAT = 'chat-1';
const MESSAGE = 'message-1';

const A_YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

function existingMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE,
    chatId: CHAT,
    authorId: AUTHOR,
    createdAt: A_YEAR_AGO,
    deletedForAll: false,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.message.findUnique.mockResolvedValue(existingMessage());
  // Both accounts are members of the one conversation.
  prisma.chatMember.findUnique.mockResolvedValue({ id: 'membership' });
  prisma.chatMember.findMany.mockResolvedValue([{ userId: OTHER }]);
  prisma.message.update.mockResolvedValue({});
  prisma.linkPreview.deleteMany.mockResolvedValue({ count: 0 });
  prisma.reaction.deleteMany.mockResolvedValue({ count: 0 });
  prisma.pinnedMessage.deleteMany.mockResolvedValue({ count: 0 });
  prisma.auditLog.create.mockResolvedValue({});
  prisma.messageDeletion.upsert.mockResolvedValue({});
});

afterEach(() => {
  resetPrismaMock(prisma);
  purgeAttachmentsForMessage.mockClear();
});

describe('delete for everyone', () => {
  it('works on a message from a year ago', async () => {
    const result = await deleteMessage(AUTHOR, { messageId: MESSAGE, scope: 'everyone' });

    expect(result.scope).toBe('everyone');
    expect(result.recipientIds).toEqual([OTHER]);
  });

  it('destroys the content rather than only flagging it', async () => {
    await deleteMessage(AUTHOR, { messageId: MESSAGE, scope: 'everyone' });

    const data = prisma.message.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.deletedForAll).toBe(true);
    // A tombstone that still holds the text is not a delete.
    expect(data.body).toBeNull();
    expect(data.bodyText).toBeNull();
    expect(data.locationLat).toBeNull();
    expect(data.locationLng).toBeNull();
  });

  it('purges the attachments, which is the only way to reclaim the storage', async () => {
    await deleteMessage(AUTHOR, { messageId: MESSAGE, scope: 'everyone' });
    expect(purgeAttachmentsForMessage).toHaveBeenCalledWith(MESSAGE);
  });

  it('still records the deletion even though the content is gone', async () => {
    await deleteMessage(AUTHOR, { messageId: MESSAGE, scope: 'everyone' });

    const audit = prisma.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(audit.userId).toBe(AUTHOR);
    expect(audit.action).toBe('MESSAGE_DELETED');
    expect(audit.metadata).toMatchObject({ messageId: MESSAGE, scope: 'everyone' });
  });

  it('refuses to let the other person withdraw a message they did not write', async () => {
    await expect(
      deleteMessage(OTHER, { messageId: MESSAGE, scope: 'everyone' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(purgeAttachmentsForMessage).not.toHaveBeenCalled();
  });

  it('refuses a non-member outright', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(null);

    await expect(
      deleteMessage('user-stranger', { messageId: MESSAGE, scope: 'everyone' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports a message that does not exist', async () => {
    prisma.message.findUnique.mockResolvedValue(null);

    await expect(
      deleteMessage(AUTHOR, { messageId: 'missing', scope: 'everyone' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('delete for me', () => {
  it('hides an old message from one side without touching the other', async () => {
    const result = await deleteMessage(OTHER, { messageId: MESSAGE, scope: 'me' });

    expect(result.scope).toBe('me');
    // Nobody else is told, because for them nothing changed.
    expect(result.recipientIds).toEqual([]);
    expect(prisma.messageDeletion.upsert).toHaveBeenCalled();
  });

  it('leaves the message and its attachments intact', async () => {
    await deleteMessage(OTHER, { messageId: MESSAGE, scope: 'me' });

    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(purgeAttachmentsForMessage).not.toHaveBeenCalled();
  });

  it('does not require being the author', async () => {
    await expect(
      deleteMessage(OTHER, { messageId: MESSAGE, scope: 'me' }),
    ).resolves.toBeDefined();
  });
});
