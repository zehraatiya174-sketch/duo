import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type MediaLibrarySummary, mediaLibrarySummary } from '@/services/media-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Totals per media group and per storage state. */
export const GET = adminRoute<Record<string, never>, MediaLibrarySummary>(async () => {
  return NextResponse.json(await mediaLibrarySummary(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
