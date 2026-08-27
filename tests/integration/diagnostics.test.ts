// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaMock, resetPrismaMock } from '../helpers/prisma-mock';

const prisma = createPrismaMock();
vi.mock('@/lib/db', () => ({ db: prisma }));

const { errorSummary, listErrorLogs, pruneErrorLogs, recordError } = await import(
  '@/services/diagnostics'
);

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'err_1',
    severity: 'ERROR',
    scope: 'upload',
    message: 'The provider refused the object',
    stack: 'Error: boom\n  at upload',
    context: { attachmentId: 'att_1' },
    createdAt: new Date('2026-07-30T10:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prisma);
  prisma.errorLog.create.mockResolvedValue({});
});

describe('recordError', () => {
  it('persists the fault as given', async () => {
    await recordError({
      severity: 'WARN',
      scope: 'socket:auth',
      message: 'Rejected an unverified session',
      context: { userId: 'usr_1' },
    });

    expect(prisma.errorLog.create).toHaveBeenCalledWith({
      data: {
        severity: 'WARN',
        scope: 'socket:auth',
        message: 'Rejected an unverified session',
        stack: null,
        context: { userId: 'usr_1' },
      },
    });
  });

  it('truncates a runaway stack rather than storing a novel', async () => {
    await recordError({
      severity: 'ERROR',
      scope: 'render',
      message: 'x'.repeat(5_000),
      stack: 'y'.repeat(20_000),
    });

    const data = prisma.errorLog.create.mock.calls[0]?.[0].data as {
      message: string;
      stack: string;
    };
    expect(data.message).toHaveLength(1_000);
    expect(data.stack).toHaveLength(4_000);
  });

  it('omits context entirely when there is none, rather than writing null', async () => {
    await recordError({ severity: 'ERROR', scope: 'x', message: 'y' });

    const data = prisma.errorLog.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect('context' in data).toBe(false);
  });

  /**
   * The whole point of the swallow: if the database is what is broken, writing
   * about it must not become a second failure on top of the first.
   */
  it('never throws when the write itself fails', async () => {
    prisma.errorLog.create.mockRejectedValue(new Error('connection refused'));

    await expect(
      recordError({ severity: 'FATAL', scope: 'db', message: 'unreachable' }),
    ).resolves.toBeUndefined();
  });
});

describe('listErrorLogs', () => {
  it('reports another page when the over-fetch comes back full', async () => {
    prisma.errorLog.findMany.mockResolvedValue([
      row({ id: 'err_1' }),
      row({ id: 'err_2' }),
      row({ id: 'err_3' }),
    ]);

    const page = await listErrorLogs({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('err_2');
    expect(prisma.errorLog.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 3 });
  });

  it('skips the cursor row so a page never repeats its predecessor', async () => {
    prisma.errorLog.findMany.mockResolvedValue([]);

    await listErrorLogs({ cursor: 'err_9' });

    expect(prisma.errorLog.findMany.mock.calls[0]?.[0]).toMatchObject({
      cursor: { id: 'err_9' },
      skip: 1,
    });
  });

  it('filters by severity and by a scope substring', async () => {
    prisma.errorLog.findMany.mockResolvedValue([]);

    await listErrorLogs({ severity: 'FATAL', scope: 'sock' });

    expect(prisma.errorLog.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { severity: 'FATAL', scope: { contains: 'sock', mode: 'insensitive' } },
    });
  });

  it('clamps an absurd limit', async () => {
    prisma.errorLog.findMany.mockResolvedValue([]);

    await listErrorLogs({ limit: 10_000 });

    expect(prisma.errorLog.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 201 });
  });

  it('serialises timestamps for the wire', async () => {
    prisma.errorLog.findMany.mockResolvedValue([row()]);

    const page = await listErrorLogs({});

    expect(page.items[0]?.createdAt).toBe('2026-07-30T10:00:00.000Z');
  });
});

describe('errorSummary', () => {
  it('folds the counts into the shape the panel reads', async () => {
    prisma.errorLog.count.mockResolvedValueOnce(42).mockResolvedValueOnce(7);
    prisma.errorLog.groupBy
      .mockResolvedValueOnce([
        { severity: 'WARN', _count: { _all: 30 } },
        { severity: 'ERROR', _count: { _all: 12 } },
      ])
      .mockResolvedValueOnce([{ scope: 'upload', _count: { _all: 5 } }]);
    prisma.errorLog.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-31T09:00:00.000Z'),
    });

    await expect(errorSummary()).resolves.toEqual({
      total: 42,
      last24h: 7,
      bySeverity: [
        { severity: 'WARN', count: 30 },
        { severity: 'ERROR', count: 12 },
      ],
      topScopes: [{ scope: 'upload', count: 5 }],
      latestAt: '2026-07-31T09:00:00.000Z',
    });
  });

  it('reports no latest entry on an empty table', async () => {
    prisma.errorLog.count.mockResolvedValue(0);
    prisma.errorLog.groupBy.mockResolvedValue([]);
    prisma.errorLog.findFirst.mockResolvedValue(null);

    await expect(errorSummary()).resolves.toMatchObject({ latestAt: null, topScopes: [] });
  });
});

describe('pruneErrorLogs', () => {
  it('deletes strictly older than the retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    prisma.errorLog.deleteMany.mockResolvedValue({ count: 3 });

    await expect(pruneErrorLogs(30)).resolves.toBe(3);

    const where = prisma.errorLog.deleteMany.mock.calls[0]?.[0].where as {
      createdAt: { lt: Date };
    };
    expect(where.createdAt.lt.toISOString()).toBe('2026-07-01T00:00:00.000Z');

    vi.useRealTimers();
  });
});
