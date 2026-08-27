import { NextResponse } from 'next/server';

import { adminRoute } from '@/lib/api/respond';
import { type AdminUserRow, listUsers } from '@/services/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute<Record<string, never>, AdminUserRow[]>(async () => {
  return NextResponse.json(await listUsers(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
