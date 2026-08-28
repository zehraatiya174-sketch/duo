import type { Prisma } from '@prisma/client';

import { randomId } from '@/lib/crypto';
import { db } from '@/lib/db';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  type MessageWithRelations,
  messageInclude,
  serializeMessage,
} from '@/lib/serializers/message';
import {
  type DeleteMessageInput,
  type EditMessageInput,
  type ForwardMessageInput,
  type ListMessagesInput,
  type ReactionInput,
  type SearchMessagesInput,
  type SendMessageInput,
  resolveMaxViews,
} from '@/lib/validation/message';
import type { MessageDTO, Page, ReactionGroup } from '@/types/models';
import { detectCodeBlock, extractUrls, stripMarkdown } from '@/utils/text';

import { applyDisappearingDefault, appSettings, messageVisibilityWhere } from './app-settings';

const log = createLogger('messages');

/** Window during which a sent message may still be edited. */
/**
 * Room for a slow link.
 *
 * These interactive transactions make several sequential round trips, and
 * Prisma closes one after 5s by default. That is ample when compute and
 * database share a region — the intended production topology — but it fails
 * outright from a laptop against a remote Neon branch, which is exactly how
 * local development runs. The work inside is unchanged; only the ceiling is.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** Window during which "delete for everyone" is permitted. */
export const DELETE_FOR_EVERYONE_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export async function assertChatMember(chatId: string, userId: string): Promise<void> {
  const membership = await db.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { id: true },
  });
  if (!membership) throw forbidden('You are not a participant in this conversation');
}

async function counterpartIds(chatId: string, userId: string): Promise<string[]> {
  const members = await db.chatMember.findMany({
    where: { chatId, userId: { not: userId } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(message: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: message.createdAt.toISOString(), id: message.id }),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.createdAt))) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateMessageResult {
  message: MessageDTO;
  /** Serialized for each recipient separately — ephemeral gating is per-viewer. */
  forRecipients: Array<{ userId: string; message: MessageDTO }>;
  recipientIds: string[];
  /** Raw row, for follow-up work such as link-preview hydration. */
  row: MessageWithRelations;
  /** True when this was a duplicate clientId and nothing new was written. */
  deduplicated: boolean;
}

/**
 * Persists a message.
 *
 * Idempotent on `clientId`: an optimistic client that retries after a dropped
 * connection gets the original message back rather than a duplicate.
 */
export async function createMessage(
  authorId: string,
  input: SendMessageInput,
): Promise<CreateMessageResult> {
  await assertChatMember(input.chatId, authorId);

  const existing = await db.message.findUnique({
    where: { clientId: input.clientId },
    include: messageInclude,
  });
  if (existing) {
    if (existing.authorId !== authorId) throw conflict('Duplicate message id');
    const recipients = await counterpartIds(input.chatId, authorId);
    return {
      message: serializeMessage(existing, authorId),
      forRecipients: recipients.map((userId) => ({
        userId,
        message: serializeMessage(existing, userId),
      })),
      recipientIds: recipients,
      row: existing,
      deduplicated: true,
    };
  }

  // --- validate references -------------------------------------------------
  if (input.replyToId) {
    const parent = await db.message.findFirst({
      where: { id: input.replyToId, chatId: input.chatId },
      select: { id: true },
    });
    if (!parent) throw notFound('The message you are replying to no longer exists');
  }

  let attachmentIds: string[] = [];
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    const attachments = await db.attachment.findMany({
      where: { id: { in: input.attachmentIds }, uploaderId: authorId, messageId: null },
      select: { id: true },
    });
    if (attachments.length !== input.attachmentIds.length) {
      throw badRequest('One or more attachments are unknown, already used, or not yours');
    }
    attachmentIds = attachments.map((a) => a.id);
  }

  // --- derive stored fields ------------------------------------------------
  const rawBody = input.body?.trim() ?? null;
  const code = rawBody ? detectCodeBlock(rawBody) : null;
  const isCodeMessage = input.type === 'CODE' || (code?.isCode ?? false);

  // The admin switch supplies the default when the sender did not pick one.
  const ephemeral = await applyDisappearingDefault(input.ephemeral);
  const maxViews = resolveMaxViews(ephemeral);
  const expiresAt = ephemeral.expiresInSeconds
    ? new Date(Date.now() + ephemeral.expiresInSeconds * 1000)
    : null;

  const recipients = await counterpartIds(input.chatId, authorId);

  const row = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        clientId: input.clientId,
        chatId: input.chatId,
        authorId,
        type: isCodeMessage ? 'CODE' : input.type,
        status: 'SENT',
        body: rawBody,
        bodyText: rawBody ? stripMarkdown(rawBody).slice(0, 8000) : null,
        codeLanguage: isCodeMessage ? (input.codeLanguage ?? code?.language ?? null) : null,
        locationLat: input.location?.lat ?? null,
        locationLng: input.location?.lng ?? null,
        locationLabel: input.location?.label ?? null,
        replyToId: input.replyToId ?? null,
        forwardedFromId: input.forwardedFromId ?? null,
        ephemeralMode: ephemeral.mode,
        maxViews,
        expiresAt,
        destructAfterSeconds: ephemeral.destructAfterSeconds ?? null,
        mentions: input.mentions
          ? {
              createMany: {
                data: input.mentions.map((m) => ({
                  userId: m.userId,
                  offset: m.offset,
                  length: m.length,
                })),
              },
            }
          : undefined,
        receipts: { createMany: { data: recipients.map((userId) => ({ userId })) } },
      },
      select: { id: true },
    });

    if (attachmentIds.length > 0) {
      await tx.attachment.updateMany({
        where: { id: { in: attachmentIds } },
        data: { messageId: created.id },
      });
    }

    if (input.forwardedFromId) {
      await tx.message.update({
        where: { id: input.forwardedFromId },
        data: { forwardCount: { increment: 1 } },
      });
    }

    await tx.chat.update({
      where: { id: input.chatId },
      data: { lastMessageAt: new Date() },
    });

    await tx.chatMember.updateMany({
      where: { chatId: input.chatId, userId: { in: recipients } },
      data: { unreadCount: { increment: 1 } },
    });

    return tx.message.findUniqueOrThrow({ where: { id: created.id }, include: messageInclude });
  }, TRANSACTION_OPTIONS);

  return {
    message: serializeMessage(row, authorId),
    forRecipients: recipients.map((userId) => ({ userId, message: serializeMessage(row, userId) })),
    recipientIds: recipients,
    row,
    deduplicated: false,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Ids of messages this user has hidden with "delete for me". */
async function hiddenMessageIds(userId: string, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db.messageDeletion.findMany({
    where: { userId, messageId: { in: messageIds } },
    select: { messageId: true },
  });
  return new Set(rows.map((r) => r.messageId));
}

/**
 * Newest-first page of a conversation. Supports both cursor paging (infinite
 * scroll upward) and `around` (jump to a specific message from search).
 */
export async function listMessages(
  userId: string,
  input: ListMessagesInput,
): Promise<Page<MessageDTO>> {
  await assertChatMember(input.chatId, userId);

  // The visibility clause goes in `AND` rather than being spread in: the
  // `around` branch below sets its own `createdAt` bound, and a spread one
  // would be silently overwritten by it.
  const baseWhere: Prisma.MessageWhereInput = {
    chatId: input.chatId,
    deletions: { none: { userId } },
    AND: [await messageVisibilityWhere()],
  };

  if (input.around) {
    const anchor = await db.message.findFirst({
      where: { id: input.around, chatId: input.chatId },
      select: { createdAt: true },
    });
    if (!anchor) throw notFound('That message no longer exists');

    const half = Math.floor(input.limit / 2);
    const [older, newerAndAnchor] = await Promise.all([
      db.message.findMany({
        where: { ...baseWhere, createdAt: { lt: anchor.createdAt } },
        include: messageInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: half,
      }),
      db.message.findMany({
        where: { ...baseWhere, createdAt: { gte: anchor.createdAt } },
        include: messageInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: half + 1,
      }),
    ]);

    const combined = [...newerAndAnchor.reverse(), ...older];
    const last = combined.at(-1);
    return {
      items: combined.map((row) => serializeMessage(row, userId)),
      nextCursor: last ? encodeCursor(last) : null,
      hasMore: older.length === half,
    };
  }

  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw badRequest('Malformed pagination cursor');

  const where: Prisma.MessageWhereInput = cursor
    ? {
        ...baseWhere,
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : baseWhere;

  const rows = await db.message.findMany({
    where,
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => serializeMessage(row, userId)),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

export async function getMessage(userId: string, messageId: string): Promise<MessageDTO> {
  const row = await db.message.findUnique({ where: { id: messageId }, include: messageInclude });
  if (!row) throw notFound('Message not found');
  await assertChatMember(row.chatId, userId);

  const hidden = await hiddenMessageIds(userId, [messageId]);
  if (hidden.has(messageId)) throw notFound('Message not found');

  const { messagesHiddenBefore } = await appSettings();
  if (messagesHiddenBefore && row.createdAt < messagesHiddenBefore) {
    throw notFound('Message not found');
  }

  return serializeMessage(row, userId);
}

/** Replays everything that changed since a timestamp, for reconnect sync. */
export async function messagesSince(
  userId: string,
  chatId: string,
  since: Date,
): Promise<MessageDTO[]> {
  await assertChatMember(chatId, userId);

  const rows = await db.message.findMany({
    where: {
      chatId,
      updatedAt: { gt: since },
      deletions: { none: { userId } },
      AND: [await messageVisibilityWhere()],
    },
    include: messageInclude,
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  return rows.map((row) => serializeMessage(row, userId));
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface MutationResult {
  message: MessageDTO;
  forRecipients: Array<{ userId: string; message: MessageDTO }>;
  recipientIds: string[];
  row: MessageWithRelations;
}

export async function editMessage(
  userId: string,
  input: EditMessageInput,
): Promise<MutationResult> {
  const existing = await db.message.findUnique({
    where: { id: input.messageId },
    select: {
      id: true,
      chatId: true,
      authorId: true,
      createdAt: true,
      deletedForAll: true,
      purgedAt: true,
      type: true,
      ephemeralMode: true,
    },
  });
  if (!existing) throw notFound('Message not found');
  if (existing.authorId !== userId) throw forbidden('You can only edit your own messages');
  if (existing.deletedForAll || existing.purgedAt) throw conflict('This message no longer exists');
  if (existing.ephemeralMode !== 'NORMAL') {
    throw conflict('Disappearing messages cannot be edited');
  }
  if (Date.now() - existing.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw conflict('The edit window for this message has closed');
  }

  const code = detectCodeBlock(input.body);

  const row = await db.message.update({
    where: { id: input.messageId },
    data: {
      body: input.body,
      bodyText: stripMarkdown(input.body).slice(0, 8000),
      type: code.isCode ? 'CODE' : existing.type === 'CODE' ? 'TEXT' : existing.type,
      codeLanguage: code.isCode ? code.language : null,
      editedAt: new Date(),
      editCount: { increment: 1 },
      // Previews are re-derived from the new body.
      linkPreviews: { deleteMany: {} },
    },
    include: messageInclude,
  });

  await db.auditLog.create({
    data: { userId, action: 'MESSAGE_EDITED', metadata: { messageId: input.messageId } },
  });

  const recipients = await counterpartIds(existing.chatId, userId);
  return {
    message: serializeMessage(row, userId),
    forRecipients: recipients.map((id) => ({ userId: id, message: serializeMessage(row, id) })),
    recipientIds: recipients,
    row,
  };
}

export interface DeleteResult {
  messageId: string;
  chatId: string;
  scope: 'me' | 'everyone';
  recipientIds: string[];
}

export async function deleteMessage(
  userId: string,
  input: DeleteMessageInput,
): Promise<DeleteResult> {
  const existing = await db.message.findUnique({
    where: { id: input.messageId },
    select: { id: true, chatId: true, authorId: true, createdAt: true, deletedForAll: true },
  });
  if (!existing) throw notFound('Message not found');
  await assertChatMember(existing.chatId, userId);

  const recipients = await counterpartIds(existing.chatId, userId);

  if (input.scope === 'me') {
    await db.messageDeletion.upsert({
      where: { messageId_userId: { messageId: existing.id, userId } },
      create: { messageId: existing.id, userId },
      update: {},
    });
    return { messageId: existing.id, chatId: existing.chatId, scope: 'me', recipientIds: [] };
  }

  if (existing.authorId !== userId) {
    throw forbidden('You can only delete your own messages for everyone');
  }
  if (Date.now() - existing.createdAt.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS) {
    throw conflict('This message is too old to delete for everyone');
  }

  await db.$transaction(async (tx) => {
    // Destroy content immediately rather than merely flagging it — a tombstone
    // that still holds the text is not a delete.
    await tx.message.update({
      where: { id: existing.id },
      data: {
        deletedForAll: true,
        deletedForAllAt: new Date(),
        body: null,
        bodyText: null,
        codeLanguage: null,
        locationLat: null,
        locationLng: null,
        locationLabel: null,
      },
    });
    await tx.linkPreview.deleteMany({ where: { messageId: existing.id } });
    await tx.reaction.deleteMany({ where: { messageId: existing.id } });
    await tx.pinnedMessage.deleteMany({ where: { messageId: existing.id } });
    await tx.auditLog.create({
      data: {
        userId,
        action: 'MESSAGE_DELETED',
        metadata: { messageId: existing.id, scope: 'everyone' },
      },
    });
  }, TRANSACTION_OPTIONS);

  // Blob destruction happens outside the transaction; it talks to the storage
  // provider and must not hold a database lock while doing so.
  const { purgeAttachmentsForMessage } = await import('./storage');
  await purgeAttachmentsForMessage(existing.id).catch((error: unknown) => {
    log.error('Failed to purge attachments for deleted message', { error, messageId: existing.id });
  });

  return {
    messageId: existing.id,
    chatId: existing.chatId,
    scope: 'everyone',
    recipientIds: recipients,
  };
}

// ---------------------------------------------------------------------------
// Reactions & pins
// ---------------------------------------------------------------------------

export interface ReactionResult {
  messageId: string;
  chatId: string;
  reactions: ReactionGroup[];
  recipientIds: string[];
  /** Per-viewer projections, because `reacted` differs per user. */
  forViewers: Array<{ userId: string; reactions: ReactionGroup[] }>;
}

export async function toggleReaction(
  userId: string,
  input: ReactionInput,
): Promise<ReactionResult> {
  const message = await db.message.findUnique({
    where: { id: input.messageId },
    select: { id: true, chatId: true, deletedForAll: true, purgedAt: true },
  });
  if (!message) throw notFound('Message not found');
  if (message.deletedForAll || message.purgedAt) throw conflict('This message no longer exists');
  await assertChatMember(message.chatId, userId);

  const existing = await db.reaction.findUnique({
    where: { messageId_userId_emoji: { messageId: input.messageId, userId, emoji: input.emoji } },
    select: { id: true },
  });

  if (existing) {
    await db.reaction.delete({ where: { id: existing.id } });
  } else {
    await db.reaction.create({
      data: { messageId: input.messageId, userId, emoji: input.emoji },
    });
  }

  const rows = await db.reaction.findMany({
    where: { messageId: input.messageId },
    select: { emoji: true, userId: true },
  });

  const members = await db.chatMember.findMany({
    where: { chatId: message.chatId },
    select: { userId: true },
  });

  const project = (viewerId: string): ReactionGroup[] => {
    const byEmoji = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byEmoji.get(row.emoji);
      if (bucket) bucket.push(row.userId);
      else byEmoji.set(row.emoji, [row.userId]);
    }
    return [...byEmoji.entries()]
      .map(([emoji, userIds]) => ({
        emoji,
        count: userIds.length,
        reacted: userIds.includes(viewerId),
        userIds,
      }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  };

  return {
    messageId: input.messageId,
    chatId: message.chatId,
    reactions: project(userId),
    recipientIds: members.map((m) => m.userId).filter((id) => id !== userId),
    forViewers: members.map((m) => ({ userId: m.userId, reactions: project(m.userId) })),
  };
}

export async function setPinned(
  userId: string,
  messageId: string,
  pinned: boolean,
): Promise<{ messageId: string; chatId: string; pinned: boolean; recipientIds: string[] }> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: { id: true, chatId: true, deletedForAll: true },
  });
  if (!message) throw notFound('Message not found');
  if (message.deletedForAll) throw conflict('This message no longer exists');
  await assertChatMember(message.chatId, userId);

  if (pinned) {
    const pinCount = await db.pinnedMessage.count({ where: { chatId: message.chatId } });
    if (pinCount >= 20) throw conflict('You can pin at most 20 messages. Unpin one first.');

    await db.pinnedMessage.upsert({
      where: { messageId },
      create: { messageId, chatId: message.chatId, pinnedById: userId },
      update: {},
    });
  } else {
    await db.pinnedMessage.deleteMany({ where: { messageId } });
  }

  const recipients = await counterpartIds(message.chatId, userId);
  return { messageId, chatId: message.chatId, pinned, recipientIds: recipients };
}

export async function listPinned(userId: string, chatId: string): Promise<MessageDTO[]> {
  await assertChatMember(chatId, userId);
  const pins = await db.pinnedMessage.findMany({
    where: { chatId, message: { is: await messageVisibilityWhere() } },
    orderBy: { createdAt: 'desc' },
    select: { message: { include: messageInclude } },
  });
  return pins.map((pin) => serializeMessage(pin.message, userId));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchMessages(
  userId: string,
  input: SearchMessagesInput,
): Promise<Page<MessageDTO>> {
  await assertChatMember(input.chatId, userId);

  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw badRequest('Malformed pagination cursor');

  const conditions: Prisma.MessageWhereInput[] = [
    { chatId: input.chatId },
    { deletions: { none: { userId } } },
    await messageVisibilityWhere(),
    { deletedForAll: false },
    { purgedAt: null },
    // Sealed ephemeral content must not be searchable — that would defeat it.
    { OR: [{ ephemeralMode: 'NORMAL' }, { authorId: userId }] },
  ];

  if (input.query.length > 0) {
    conditions.push({
      OR: [
        { bodyText: { contains: input.query, mode: 'insensitive' } },
        { attachments: { some: { fileName: { contains: input.query, mode: 'insensitive' } } } },
        { linkPreviews: { some: { title: { contains: input.query, mode: 'insensitive' } } } },
        { linkPreviews: { some: { url: { contains: input.query, mode: 'insensitive' } } } },
      ],
    });
  }

  if (input.type) conditions.push({ type: input.type });
  if (input.authorId) conditions.push({ authorId: input.authorId });
  if (input.kind) conditions.push({ attachments: { some: { kind: input.kind } } });
  if (input.hasAttachment) conditions.push({ attachments: { some: {} } });
  if (input.hasLink) conditions.push({ linkPreviews: { some: {} } });
  if (input.from) conditions.push({ createdAt: { gte: input.from } });
  if (input.to) conditions.push({ createdAt: { lte: input.to } });

  if (cursor) {
    conditions.push({
      OR: [
        { createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await db.message.findMany({
    where: { AND: conditions },
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => serializeMessage(row, userId)),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Link previews
// ---------------------------------------------------------------------------

/**
 * Fetches OG metadata for any URLs in a freshly sent message. Runs after the
 * message is already delivered so a slow remote server never delays the send.
 */
export async function hydrateLinkPreviews(
  messageId: string,
  body: string | null,
): Promise<boolean> {
  if (!body) return false;
  const urls = extractUrls(body).slice(0, 3);
  if (urls.length === 0) return false;

  const { fetchLinkPreview } = await import('./link-preview');

  const previews = await Promise.all(
    urls.map(async (url) => {
      try {
        return await fetchLinkPreview(url);
      } catch (error) {
        log.debug('Link preview failed', { url, error });
        return null;
      }
    }),
  );

  const usable = previews.filter((p): p is NonNullable<typeof p> => p !== null);
  if (usable.length === 0) return false;

  // The message may have been deleted while we were fetching.
  const stillExists = await db.message.findFirst({
    where: { id: messageId, deletedForAll: false, purgedAt: null },
    select: { id: true },
  });
  if (!stillExists) return false;

  await db.linkPreview.createMany({
    data: usable.map((preview) => ({ messageId, ...preview })),
  });

  return true;
}

export async function reloadMessage(messageId: string): Promise<MessageWithRelations | null> {
  return db.message.findUnique({ where: { id: messageId }, include: messageInclude });
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

/**
 * Re-sends existing messages as new ones authored by the forwarder.
 *
 * Disappearing messages are never forwardable: passing along a view-once photo
 * would silently strip the constraint its sender chose, so the attempt is
 * rejected rather than quietly downgraded to a normal message.
 *
 * Attachments are copied rather than re-linked. Sharing a storage object
 * between two messages would mean purging one destroys the other's media.
 */
export async function forwardMessages(
  userId: string,
  input: ForwardMessageInput,
): Promise<CreateMessageResult[]> {
  await assertChatMember(input.chatId, userId);

  const sources = await db.message.findMany({
    where: { id: { in: input.messageIds }, deletions: { none: { userId } } },
    include: messageInclude,
  });
  if (sources.length !== input.messageIds.length) {
    throw notFound('One or more messages could not be found');
  }

  const { loadAttachment, storeAttachment } = await import('./storage');
  const results: CreateMessageResult[] = [];

  // Preserve the order the caller asked for rather than the database's.
  const byId = new Map(sources.map((source) => [source.id, source]));

  for (const messageId of input.messageIds) {
    const source = byId.get(messageId);
    if (!source) continue;

    await assertChatMember(source.chatId, userId);

    if (source.deletedForAll || source.purgedAt) {
      throw conflict('That message no longer exists');
    }
    if (source.ephemeralMode !== 'NORMAL') {
      throw forbidden('Disappearing messages cannot be forwarded');
    }

    const attachmentIds: string[] = [];
    for (const attachment of source.attachments) {
      if (attachment.purgedAt) continue;
      const loaded = await loadAttachment(attachment.id);
      const copy = await storeAttachment({
        uploaderId: userId,
        fileName: loaded.fileName,
        mimeType: loaded.mimeType,
        bytes: loaded.bytes,
      });
      attachmentIds.push(copy.id);
    }

    const result = await createMessage(userId, {
      clientId: randomId(16),
      chatId: input.chatId,
      type: source.type,
      body: source.body ?? undefined,
      codeLanguage: source.codeLanguage ?? undefined,
      forwardedFromId: source.id,
      attachmentIds,
      location:
        source.locationLat !== null && source.locationLng !== null
          ? {
              lat: source.locationLat,
              lng: source.locationLng,
              label: source.locationLabel ?? undefined,
            }
          : undefined,
      ephemeral: { mode: 'NORMAL' },
    });

    results.push(result);
  }

  return results;
}
