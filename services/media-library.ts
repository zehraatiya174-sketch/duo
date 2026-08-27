import type { AttachmentKind, EphemeralMode, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import type { Page } from '@/types/models';

/**
 * The admin media library.
 *
 * This is a storage-management view, not a viewer. It deliberately returns no
 * URL, no signed path, no thumbnail and no preview of any kind: the operator is
 * one of the two people in the conversation, and the other one's attachments are
 * not the administrator's to open from a console.
 *
 * Disappearing media is listed too — the spec asks for it, and an entry that
 * occupies bytes has to be visible to whoever manages the bytes — but only as
 * size, timing and state. Where an attachment belongs to an ephemeral message
 * the file name is withheld as well: "scan-of-the-letter.pdf" is content.
 */

/** What a row is doing to storage right now. */
export type MediaState =
  /** Attached to a normal message; occupies space until the message is deleted. */
  | 'stored'
  /** Attached to a disappearing message that has not been spent yet. */
  | 'disappearing'
  /** Its disappearing message has expired but the sweep has not run. */
  | 'expired'
  /** The blob has been destroyed; the row survives as a tombstone. */
  | 'purged'
  /** Uploaded but never attached to a message. Reclaimable. */
  | 'orphaned';

export interface MediaLibraryRow {
  id: string;
  kind: AttachmentKind;
  /** Null for anything ephemeral — see the note at the top of this module. */
  fileName: string | null;
  mimeType: string;
  byteSize: number;
  provider: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  uploaderEmail: string;
  uploadedAt: string;
  state: MediaState;
  ephemeralMode: EphemeralMode | null;
  /** When the parent message expires, where it has an expiry at all. */
  expiresAt: string | null;
  purgedAt: string | null;
  encrypted: boolean;
}

export type MediaLibraryGroup = 'photos' | 'videos' | 'documents' | 'voice' | 'other';

/** The four groups the panel offers, mapped onto the attachment enum. */
const GROUP_KINDS: Record<MediaLibraryGroup, readonly AttachmentKind[]> = {
  photos: ['IMAGE', 'GIF', 'STICKER'],
  videos: ['VIDEO'],
  documents: ['DOCUMENT', 'ARCHIVE'],
  voice: ['VOICE_NOTE', 'AUDIO'],
  other: ['OTHER'],
};

export interface MediaLibraryFilter {
  cursor?: string | null;
  limit?: number;
  group?: MediaLibraryGroup;
  state?: MediaState;
}

/** Translates the coarse state filter into a query the database can answer. */
function stateWhere(state: MediaState | undefined): Prisma.AttachmentWhereInput {
  const now = new Date();
  switch (state) {
    case 'purged':
      return { purgedAt: { not: null } };
    case 'orphaned':
      return { messageId: null, purgedAt: null };
    case 'expired':
      return {
        purgedAt: null,
        message: { is: { ephemeralMode: { not: 'NORMAL' }, expiresAt: { lt: now } } },
      };
    case 'disappearing':
      return {
        purgedAt: null,
        message: {
          is: {
            ephemeralMode: { not: 'NORMAL' },
            OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
          },
        },
      };
    case 'stored':
      return { purgedAt: null, message: { is: { ephemeralMode: 'NORMAL' } } };
    default:
      return {};
  }
}

function stateOf(
  attachment: {
    purgedAt: Date | null;
    messageId: string | null;
  },
  message: { ephemeralMode: EphemeralMode; expiresAt: Date | null; purgedAt: Date | null } | null,
): MediaState {
  if (attachment.purgedAt || message?.purgedAt) return 'purged';
  if (!attachment.messageId || !message) return 'orphaned';
  if (message.ephemeralMode === 'NORMAL') return 'stored';
  if (message.expiresAt && message.expiresAt.getTime() < Date.now()) return 'expired';
  return 'disappearing';
}

export async function listMediaLibrary(input: MediaLibraryFilter): Promise<Page<MediaLibraryRow>> {
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);

  const where: Prisma.AttachmentWhereInput = {
    ...(input.group ? { kind: { in: [...GROUP_KINDS[input.group]] } } : {}),
    ...stateWhere(input.state),
  };

  const rows = await db.attachment.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      provider: true,
      width: true,
      height: true,
      duration: true,
      createdAt: true,
      purgedAt: true,
      messageId: true,
      encrypted: true,
      uploader: { select: { email: true } },
      message: { select: { ephemeralMode: true, expiresAt: true, purgedAt: true } },
      // Deliberately absent: storageKey, localPath, thumbnailKey, blurDataUrl
      // and the encryption material. None of them belong in a JSON response.
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => {
      const state = stateOf(row, row.message);
      const ephemeral = state === 'disappearing' || state === 'expired' || state === 'purged';

      return {
        id: row.id,
        kind: row.kind,
        fileName: ephemeral ? null : row.fileName,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        provider: row.provider,
        width: row.width,
        height: row.height,
        durationSec: row.duration,
        uploaderEmail: row.uploader.email,
        uploadedAt: row.createdAt.toISOString(),
        state,
        ephemeralMode: row.message?.ephemeralMode ?? null,
        expiresAt: row.message?.expiresAt?.toISOString() ?? null,
        purgedAt: row.purgedAt?.toISOString() ?? null,
        encrypted: row.encrypted,
      };
    }),
    nextCursor: hasMore && last ? last.id : null,
    hasMore,
  };
}

export interface MediaLibrarySummary {
  groups: Array<{ group: MediaLibraryGroup; count: number; bytes: number }>;
  states: Array<{ state: MediaState; count: number; bytes: number }>;
}

/** Headline counts for the library, so the panel can lead with the totals. */
export async function mediaLibrarySummary(): Promise<MediaLibrarySummary> {
  const byKind = await db.attachment.groupBy({
    by: ['kind'],
    _count: { _all: true },
    _sum: { byteSize: true },
  });

  const groups = (Object.keys(GROUP_KINDS) as MediaLibraryGroup[]).map((group) => {
    const kinds = new Set<AttachmentKind>(GROUP_KINDS[group]);
    const rows = byKind.filter((row) => kinds.has(row.kind));
    return {
      group,
      count: rows.reduce((sum, row) => sum + row._count._all, 0),
      bytes: rows.reduce((sum, row) => sum + (row._sum.byteSize ?? 0), 0),
    };
  });

  const states: MediaState[] = ['stored', 'disappearing', 'expired', 'purged', 'orphaned'];
  const counted = await Promise.all(
    states.map(async (state) => {
      const where = stateWhere(state);
      const aggregate = await db.attachment.aggregate({
        where,
        _count: { _all: true },
        _sum: { byteSize: true },
      });
      return {
        state,
        count: aggregate._count._all,
        // A purged row still has its recorded size, which is what makes the
        // difference between "reclaimed" and "still occupying space" legible.
        bytes: aggregate._sum.byteSize ?? 0,
      };
    }),
  );

  return { groups, states: counted };
}
