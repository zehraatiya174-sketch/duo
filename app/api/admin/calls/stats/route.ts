import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type CallStats, callStats } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connection outcomes and link quality, summarised over the whole history. */
export const GET = adminRoute<Record<string, never>, CallStats>(async () => {
  return NextResponse.json(await callStats(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
