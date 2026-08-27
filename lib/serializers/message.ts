import type { Prisma } from '@prisma/client';

import { createSignedMediaPath } from '@/lib/crypto';
import { countConsumed } from '@/lib/ephemeral/session';
import type {
  AttachmentDTO,
  EphemeralStateDTO,
  LinkPreviewDTO,
  MessageDTO,
  MessageReferenceDTO,
  ReactionGroup,
} from '@/types/models';

/**
 * The exact relation graph every message read path must load. Declared once so
 * the serializer can never receive a partially-hydrated row.
 */
export const messageInclude = {
  author: { select: { id: true, name: true } },
  attachments: true,
  reactions: { select: { emoji: true, userId: true } },
  linkPreviews: true,
  mentions: { select: { userId: true, offset: true, length: true } },
  pin: { select: { id: true } },
  receipts: { select: { userId: true, deliveredAt: true, readAt: true } },
  views: {
    select: { userId: true, viewedAt: true, state: true, leaseExpiresAt: true, renderedAt: true },
  },
  replyTo: {
    select: {
      id: true,
      authorId: true,
      type: true,
      body: true,
      deletedForAll: true,
      purgedAt: true,
      author: { select: { name: true } },
      attachments: { select: { kind: true, fileName: true } },
    },
  },
  forwardedFrom: {
    select: {
      id: true,
      authorId: true,
      type: true,
      body: true,
      deletedForAll: true,
      purgedAt: true,
      author: { select: { name: true } },
      attachments: { select: { kind: true, fileName: true } },
    },
  },
} satisfies Prisma.MessageInclude;

export type MessageWithRelations = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

type ReferenceRow = NonNullable<MessageWithRelations['replyTo']>;

const KIND_LABEL: Record<string, string> = {
  IMAGE: 'Photo',
  VIDEO: 'Video',
  AUDIO: 'Audio',
  VOICE_NOTE: 'Voice note',
  DOCUMENT: 'Document',
  ARCHIVE: 'Archive',
  GIF: 'GIF',
  STICKER: 'Sticker',
  OTHER: 'File',
};

function referencePreview(row: ReferenceRow): string {
  if (row.deletedForAll || row.purgedAt) return 'Message deleted';
  if (row.body && row.body.trim().length > 0) {
    const flat = row.body.replace(/\s+/g, ' ').trim();
    return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  }
  const first = row.attachments[0];
  if (first) return KIND_LABEL[first.kind] ?? first.fileName;
  return 'Message';
}

function toReference(row: ReferenceRow | null): MessageReferenceDTO | null {
  if (!row) return null;
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: row.author.name,
    type: row.type,
    preview: referencePreview(row),
    deleted: row.deletedForAll || row.purgedAt !== null,
  };
}

function groupReactions(
  rows: ReadonlyArray<{ emoji: string; userId: string }>,
  viewerId: string,
): ReactionGroup[] {
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
}

function serializeLinkPreviews(rows: MessageWithRelations['linkPreviews']): LinkPreviewDTO[] {
  return rows.map((row) => ({
    id: row.id,
    url: row.canonicalUrl ?? row.url,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    siteName: row.siteName,
    faviconUrl: row.faviconUrl,
  }));
}

function serializeAttachment(
  row: MessageWithRelations['attachments'][number],
  viewerId: string,
  reveal: boolean,
): AttachmentDTO {
  const purged = row.purgedAt !== null;
  const canLink = reveal && !purged;

  return {
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    duration: row.duration,
    waveform: row.waveform,
    // The blur placeholder is metadata, not content, but it still leaks a
    // low-frequency impression of a sealed image — so it is withheld too.
    blurDataUrl: canLink ? row.blurDataUrl : null,
    url: canLink
      ? createSignedMediaPath({ attachmentId: row.id, userId: viewerId, disposition: 'inline' })
      : null,
    thumbnailUrl:
      canLink && row.thumbnailKey
        ? createSignedMediaPath({
            attachmentId: row.id,
            userId: viewerId,
            disposition: 'inline',
            variant: 'thumb',
          })
        : null,
    downloadUrl: canLink
      ? createSignedMediaPath({ attachmentId: row.id, userId: viewerId, disposition: 'attachment' })
      : null,
    purged,
  };
}

export interface EphemeralEvaluation {
  state: EphemeralStateDTO;
  /** Whether the viewer is currently entitled to see the content. */
  reveal: boolean;
}

/**
 * Decides what an ephemeral message looks like to one particular viewer.
 *
 * The author always sees their own message — re-reading what you sent does not
 * consume the recipient's allowance. For the recipient, content is sealed
 * unless they hold a live reservation on it.
 *
 * Entitlement follows the *session*, not a tally of past opens. A reader who
 * has reserved a look keeps seeing the content until they close the viewer or
 * the lease lapses, which is what lets them refresh the page mid-view without
 * either losing the picture or being charged a second look.
 */
export function evaluateEphemeral(
  message: MessageWithRelations,
  viewerId: string,
  forceReveal: boolean,
): EphemeralEvaluation {
  const isAuthor = message.authorId === viewerId;
  const now = Date.now();

  if (message.ephemeralMode === 'NORMAL') {
    const expired = message.expiresAt !== null && message.expiresAt.getTime() <= now;
    return {
      state: {
        mode: 'NORMAL',
        maxViews: null,
        viewCount: message.viewCount,
        remainingViews: null,
        expiresAt: message.expiresAt?.toISOString() ?? null,
        destructAfterSeconds: null,
        destructStartedAt: null,
        consumed: expired || message.purgedAt !== null,
        viewing: false,
        unopened: false,
      },
      reveal: !expired && message.purgedAt === null,
    };
  }

  const sessions = message.views.filter((v) => v.userId === viewerId);
  const maxViews = message.maxViews;
  const { spent, held } = countConsumed(sessions, now);
  const remainingViews = maxViews === null ? null : Math.max(0, maxViews - (spent + held));

  const expiredByClock = message.expiresAt !== null && message.expiresAt.getTime() <= now;
  const expiredByCountdown =
    message.destructAfterSeconds !== null &&
    message.destructStartedAt !== null &&
    message.destructStartedAt.getTime() + message.destructAfterSeconds * 1000 <= now;

  const purged = message.purgedAt !== null;
  const viewing = held > 0;
  // Out of looks only when none are left *and* none is in progress. A held
  // reservation is a look still being taken, not one already gone.
  const viewsExhausted = maxViews !== null && !viewing && spent >= maxViews;
  const consumed = purged || expiredByClock || expiredByCountdown || (!isAuthor && viewsExhausted);

  const state: EphemeralStateDTO = {
    mode: message.ephemeralMode,
    maxViews,
    viewCount: message.viewCount,
    remainingViews: isAuthor ? maxViews : remainingViews,
    expiresAt: message.expiresAt?.toISOString() ?? null,
    destructAfterSeconds: message.destructAfterSeconds,
    destructStartedAt: message.destructStartedAt?.toISOString() ?? null,
    consumed,
    viewing: !isAuthor && viewing,
    unopened: !isAuthor && sessions.length === 0 && !consumed,
  };

  if (purged || expiredByClock || expiredByCountdown) return { state, reveal: false };
  // The author can always re-read their own ephemeral message.
  if (isAuthor) return { state, reveal: true };
  // The recipient sees content while a reservation is live — either the one
  // this very request just took, or one taken moments ago that they are still
  // looking at.
  return { state, reveal: (forceReveal || viewing) && !viewsExhausted };
}

export interface SerializeOptions {
  /**
   * Set only by the ephemeral open handler. Everywhere else this stays false so
   * that a plain timeline fetch can never leak sealed content.
   */
  revealEphemeral?: boolean;
}

export function serializeMessage(
  message: MessageWithRelations,
  viewerId: string,
  options: SerializeOptions = {},
): MessageDTO {
  const isAuthor = message.authorId === viewerId;
  const { state: ephemeralState, reveal } = evaluateEphemeral(
    message,
    viewerId,
    options.revealEphemeral ?? false,
  );

  const hidden = message.deletedForAll || message.purgedAt !== null;
  const showContent = !hidden && reveal;

  const counterpartReceipt = message.receipts.find((r) => r.userId !== message.authorId);

  return {
    id: message.id,
    clientId: message.clientId,
    chatId: message.chatId,
    authorId: message.authorId,
    type: message.type,
    status: message.status,
    body: showContent ? message.body : null,
    codeLanguage: showContent ? message.codeLanguage : null,
    location:
      showContent && message.locationLat !== null && message.locationLng !== null
        ? { lat: message.locationLat, lng: message.locationLng, label: message.locationLabel }
        : null,

    replyTo: toReference(message.replyTo),
    forwardedFrom: toReference(message.forwardedFrom),

    attachments: hidden
      ? []
      : message.attachments.map((a) => serializeAttachment(a, viewerId, showContent)),
    reactions: groupReactions(message.reactions, viewerId),
    linkPreviews: showContent ? serializeLinkPreviews(message.linkPreviews) : [],
    mentions: message.mentions.map((m) => ({
      userId: m.userId,
      offset: m.offset,
      length: m.length,
    })),

    ephemeral:
      message.ephemeralMode === 'NORMAL' && message.expiresAt === null ? null : ephemeralState,

    editedAt: message.editedAt?.toISOString() ?? null,
    editCount: message.editCount,
    deletedForAll: message.deletedForAll,
    pinned: message.pin !== null,

    // Receipt timestamps are the author's business only.
    deliveredAt: isAuthor ? (counterpartReceipt?.deliveredAt?.toISOString() ?? null) : null,
    readAt: isAuthor ? (counterpartReceipt?.readAt?.toISOString() ?? null) : null,

    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

/** Tombstone shown in place of a message the viewer deleted for themselves. */
export function serializeDeletedForMe(message: MessageWithRelations): MessageDTO {
  return {
    id: message.id,
    clientId: message.clientId,
    chatId: message.chatId,
    authorId: message.authorId,
    type: 'SYSTEM',
    status: message.status,
    body: null,
    codeLanguage: null,
    location: null,
    replyTo: null,
    forwardedFrom: null,
    attachments: [],
    reactions: [],
    linkPreviews: [],
    mentions: [],
    ephemeral: null,
    editedAt: null,
    editCount: 0,
    deletedForAll: true,
    pinned: false,
    deliveredAt: null,
    readAt: null,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
