// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaMock, resetPrismaMock } from '../helpers/prisma-mock';

const prisma = createPrismaMock();
vi.mock('@/lib/db', () => ({ db: prisma }));

const { listMediaLibrary, mediaLibrarySummary } = await import('@/services/media-library');

const NOW = new Date('2026-07-31T12:00:00.000Z');
const PAST = new Date('2026-07-30T12:00:00.000Z');
const FUTURE = new Date('2026-08-01T12:00:00.000Z');

/** A stored photo. Individual tests override only the field under test. */
function attachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'att_1',
    kind: 'IMAGE',
    fileName: 'scan-of-the-letter.pdf',
    mimeType: 'image/jpeg',
    byteSize: 2_048,
    provider: 'cloudinary',
    width: 1_200,
    height: 800,
    duration: null,
    createdAt: PAST,
    purgedAt: null,
    messageId: 'msg_1',
    encrypted: false,
    uploader: { email: 'alice@example.com' },
    message: { ephemeralMode: 'NORMAL', expiresAt: null, purgedAt: null },
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prisma);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  prisma.attachment.findMany.mockResolvedValue([]);
  prisma.attachment.groupBy.mockResolvedValue([]);
  prisma.attachment.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { byteSize: null } });
});

describe('listMediaLibrary', () => {
  /**
   * The privacy contract of this module, asserted rather than assumed: if any
   * of these ever appear in the projection, the response becomes a viewer for
   * the other account's attachments.
   */
  it('never selects a field that could reconstruct the file', async () => {
    await listMediaLibrary({});

    const select = prisma.attachment.findMany.mock.calls[0]?.[0].select as Record<string, unknown>;
    for (const field of ['storageKey', 'localPath', 'thumbnailKey', 'blurDataUrl', 'encryptionKey']) {
      expect(select).not.toHaveProperty(field);
    }
  });

  it('keeps the file name for ordinary stored media', async () => {
    prisma.attachment.findMany.mockResolvedValue([attachment()]);

    const page = await listMediaLibrary({});

    expect(page.items[0]).toMatchObject({ state: 'stored', fileName: 'scan-of-the-letter.pdf' });
  });

  it.each([
    ['disappearing', { ephemeralMode: 'VIEW_ONCE', expiresAt: FUTURE, purgedAt: null }],
    ['expired', { ephemeralMode: 'VIEW_ONCE', expiresAt: PAST, purgedAt: null }],
  ] as const)('withholds the file name for %s media', async (state, message) => {
    prisma.attachment.findMany.mockResolvedValue([attachment({ message })]);

    const page = await listMediaLibrary({});

    expect(page.items[0]).toMatchObject({ state, fileName: null });
  });

  it('treats a purged blob as a tombstone that keeps its recorded size', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      attachment({ purgedAt: PAST, byteSize: 4_096 }),
    ]);

    const page = await listMediaLibrary({});

    expect(page.items[0]).toMatchObject({
      state: 'purged',
      fileName: null,
      byteSize: 4_096,
      purgedAt: PAST.toISOString(),
    });
  });

  it('calls an attachment with no message orphaned', async () => {
    prisma.attachment.findMany.mockResolvedValue([attachment({ messageId: null, message: null })]);

    const page = await listMediaLibrary({});

    // Orphans were never in a conversation, so there is no content to protect.
    expect(page.items[0]).toMatchObject({ state: 'orphaned', fileName: 'scan-of-the-letter.pdf' });
  });

  it('maps the coarse group filter onto the attachment kinds', async () => {
    await listMediaLibrary({ group: 'voice' });

    expect(prisma.attachment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { kind: { in: ['VOICE_NOTE', 'AUDIO'] } },
    });
  });

  it('asks for expired media by an expiry in the past on a non-normal message', async () => {
    await listMediaLibrary({ state: 'expired' });

    const where = prisma.attachment.findMany.mock.calls[0]?.[0].where as {
      purgedAt: unknown;
      message: { is: { expiresAt: { lt: Date } } };
    };
    expect(where.purgedAt).toEqual(null);
    expect(where.message.is.expiresAt.lt.toISOString()).toBe(NOW.toISOString());
  });

  it('pages with a cursor and reports whether more remain', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      attachment({ id: 'att_1' }),
      attachment({ id: 'att_2' }),
      attachment({ id: 'att_3' }),
    ]);

    const page = await listMediaLibrary({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('att_2');
  });

  it('clamps the page size', async () => {
    await listMediaLibrary({ limit: 5_000 });

    expect(prisma.attachment.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 101 });
  });
});

describe('mediaLibrarySummary', () => {
  it('folds attachment kinds into the four groups the panel offers', async () => {
    prisma.attachment.groupBy.mockResolvedValue([
      { kind: 'IMAGE', _count: { _all: 4 }, _sum: { byteSize: 400 } },
      { kind: 'GIF', _count: { _all: 1 }, _sum: { byteSize: 100 } },
      { kind: 'VOICE_NOTE', _count: { _all: 2 }, _sum: { byteSize: 200 } },
    ]);

    const summary = await mediaLibrarySummary();
    const groups = new Map(summary.groups.map((row) => [row.group, row]));

    expect(groups.get('photos')).toEqual({ group: 'photos', count: 5, bytes: 500 });
    expect(groups.get('voice')).toEqual({ group: 'voice', count: 2, bytes: 200 });
    expect(groups.get('videos')).toEqual({ group: 'videos', count: 0, bytes: 0 });
  });

  it('reports every state, including the ones with nothing in them', async () => {
    const summary = await mediaLibrarySummary();

    expect(summary.states.map((row) => row.state)).toEqual([
      'stored',
      'disappearing',
      'expired',
      'purged',
      'orphaned',
    ]);
    expect(summary.states.every((row) => row.count === 0 && row.bytes === 0)).toBe(true);
  });
});
