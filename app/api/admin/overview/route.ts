import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { adminOverview, type AdminOverview } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Counters and the activity series behind the console's landing tab. */
export const GET = adminRoute<Record<string, never>, AdminOverview>(async () => {
  return NextResponse.json<AdminOverview>(await adminOverview());
});
