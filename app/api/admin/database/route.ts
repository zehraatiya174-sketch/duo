import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type DatabaseStatus, databaseStatus } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connectivity, engine version, on-disk size and per-table row counts. */
export const GET = adminRoute<Record<string, never>, DatabaseStatus>(async () => {
  return NextResponse.json(await databaseStatus(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
