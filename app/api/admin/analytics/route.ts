import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type SystemAnalytics, systemAnalytics } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Fourteen days of activity, and how it splits by type, hour and account. */
export const GET = adminRoute<Record<string, never>, SystemAnalytics>(async () => {
  return NextResponse.json(await systemAnalytics(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
