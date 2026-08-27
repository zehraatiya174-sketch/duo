import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type ErrorSummary, errorSummary } from '@/services/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Counts by severity and the noisiest scopes of the last day. */
export const GET = adminRoute<Record<string, never>, ErrorSummary>(async () => {
  return NextResponse.json(await errorSummary(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
