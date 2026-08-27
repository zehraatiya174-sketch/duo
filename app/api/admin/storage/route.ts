import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { db } from '@/lib/db';
import { pruneOrphanAttachments, type StorageBreakdown, storageUsage } from '@/services/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute<Record<string, never>, StorageBreakdown>(async () => {
  const [usage, grouped, orphaned] = await Promise.all([
    storageUsage(),
    db.attachment.groupBy({
      by: ['kind'],
      where: { purgedAt: null },
      _count: { _all: true },
      _sum: { byteSize: true },
    }),
    db.attachment.count({ where: { messageId: null, purgedAt: null } }),
  ]);

  return NextResponse.json<StorageBreakdown>(
    {
      usage,
      byKind: grouped.map((row) => ({
        kind: row.kind,
        count: row._count._all,
        bytes: row._sum.byteSize ?? 0,
      })),
      orphaned,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
});

/** Reclaims uploads that were never attached to a message. */
export const POST = adminRoute<Record<string, never>, { pruned: number }>(async () => {
  return NextResponse.json({ pruned: await pruneOrphanAttachments() });
});
