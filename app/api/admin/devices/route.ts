import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type AdminDeviceRow, listDevices } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every device either account has signed in from, and whether it is live. */
export const GET = adminRoute<Record<string, never>, AdminDeviceRow[]>(async () => {
  return NextResponse.json(await listDevices(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
