import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { systemHealth, type SystemHealth } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The detailed counterpart to `/api/health`.
 *
 * Admin-only precisely because it is detailed: connection counts, heap usage
 * and the database's error text are useful to the operator and useful to an
 * attacker, so unlike the public probe this one is gated.
 */
export const GET = adminRoute<Record<string, never>, SystemHealth>(async () => {
  return NextResponse.json<SystemHealth>(await systemHealth());
});
