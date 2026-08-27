import type { AttachmentKind, Prisma } from '@prisma/client';

import { createSignedMediaPath } from '@/lib/crypto';
import { db } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import type { AttachmentDTO, LinkPreviewDTO, Page } from '@/types/models';

import { messageVisibilityWhere } from './app-settings';
import { assertChatMember, decodeCursor, encodeCursor } from './messages';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export interface SharedMediaItem {
  attachment: AttachmentDTO;
  messageId: string;
  authorId: string;
  createdAt: string;
}

export interface SharedLinkItem extends LinkPreviewDTO {
  messageId: string;
  authorId: string;
  createdAt: string;
}

export interface SharedMediaFilter {
  chatId: string;
  kinds?: readonly AttachmentKind[];
  cursor?: string | null;
  limit?: number;
}

/**
 * Sealed ephemeral content never appears in the gallery. A "view once" photo
 * that could be re-opened from the shared-media grid would not be view-once at
 * all, so the exclusion lives in the query rather than in the UI.
 */
async function visibleMessageFilter(userId: string): Promise<Prisma.MessageWhereInput> {
  return {
    deletions: { none: { userId } },
    deletedForAll: false,
    purgedAt: null,
    OR: [{ ephemeralMode: 'NORMAL' }, { authorId: userId }],
    // Media from a history the admin has withdrawn must not survive in the
    // gallery — the grid would otherwise be a way straight back to it.
    ...(await messageVisibilityWhere()),
  };
}

export async function listSharedMedia(
  userId: string,
  filter: SharedMediaFilter,
): Promise<Page<SharedMediaItem>> {
  await assertChatMember(filter.chatId, userId);

  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
  if (filter.cursor && !cursor) throw badRequest('Malformed pagination cursor');

  const rows = await db.attachment.findMany({
    where: {
      purgedAt: null,
      ...(filter.kinds && filter.kinds.length > 0 ? { kind: { in: [...filter.kinds] } } : {}),
      message: {
        is: { chatId: filter.chatId, ...(await visibleMessageFilter(userId)) },
      },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      width: true,
      height: true,
      duration: true,
      waveform: true,
      blurDataUrl: true,
      thumbnailKey: true,
      createdAt: true,
      messageId: true,
      message: { select: { authorId: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => ({
      messageId: row.messageId ?? '',
      authorId: row.message?.authorId ?? '',
      createdAt: row.createdAt.toISOString(),
      attachment: {
        id: row.id,
        kind: row.kind,
        fileName: row.fileName,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        width: row.width,
        height: row.height,
        duration: row.duration,
        waveform: row.waveform,
        blurDataUrl: row.blurDataUrl,
        url: createSignedMediaPath({
          attachmentId: row.id,
          userId,
          disposition: 'inline',
        }),
        thumbnailUrl: row.thumbnailKey
          ? createSignedMediaPath({
              attachmentId: row.id,
              userId,
              disposition: 'inline',
              variant: 'thumb',
            })
          : null,
        downloadUrl: createSignedMediaPath({
          attachmentId: row.id,
          userId,
          disposition: 'attachment',
        }),
        purged: false,
      },
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

export async function listSharedLinks(
  userId: string,
  filter: Omit<SharedMediaFilter, 'kinds'>,
): Promise<Page<SharedLinkItem>> {
  await assertChatMember(filter.chatId, userId);

  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
  if (filter.cursor && !cursor) throw badRequest('Malformed pagination cursor');

  const rows = await db.linkPreview.findMany({
    where: {
      message: { is: { chatId: filter.chatId, ...(await visibleMessageFilter(userId)) } },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: { message: { select: { id: true, authorId: true } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => ({
      id: row.id,
      url: row.canonicalUrl ?? row.url,
      title: row.title,
      description: row.description,
      imageUrl: row.imageUrl,
      siteName: row.siteName,
      faviconUrl: row.faviconUrl,
      messageId: row.message.id,
      authorId: row.message.authorId,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

export interface SharedMediaCounts {
  images: number;
  videos: number;
  voiceNotes: number;
  documents: number;
  links: number;
}

/** Powers the tab badges on the shared-media panel. */
export async function sharedMediaCounts(
  userId: string,
  chatId: string,
): Promise<SharedMediaCounts> {
  await assertChatMember(chatId, userId);

  const messageWhere = { chatId, ...(await visibleMessageFilter(userId)) };
  const attachmentWhere = { purgedAt: null, message: { is: messageWhere } };

  const [images, videos, voiceNotes, documents, links] = await Promise.all([
    db.attachment.count({
      where: { ...attachmentWhere, kind: { in: ['IMAGE', 'GIF', 'STICKER'] } },
    }),
    db.attachment.count({ where: { ...attachmentWhere, kind: 'VIDEO' } }),
    db.attachment.count({ where: { ...attachmentWhere, kind: { in: ['VOICE_NOTE', 'AUDIO'] } } }),
    db.attachment.count({
      where: { ...attachmentWhere, kind: { in: ['DOCUMENT', 'ARCHIVE', 'OTHER'] } },
    }),
    db.linkPreview.count({ where: { message: { is: messageWhere } } }),
  ]);

  return { images, videos, voiceNotes, documents, links };
}
