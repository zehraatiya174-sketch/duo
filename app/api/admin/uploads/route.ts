import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type UploadStats, uploadStats } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Upload statistics, read from attachment metadata rather than the objects. */
export const GET = adminRoute<Record<string, never>, UploadStats>(async () => {
  return NextResponse.json(await uploadStats(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
