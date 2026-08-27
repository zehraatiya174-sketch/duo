import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, searchParamsToObject } from '@/lib/api/respond';
import { type AdminCallRow, listCalls } from '@/services/admin';
import type { Page } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(['RINGING', 'ONGOING', 'ENDED', 'MISSED', 'DECLINED', 'FAILED']).optional(),
});

/** The call log: envelopes only. No call is recorded, so none can be replayed. */
export const GET = adminRoute<Record<string, never>, Page<AdminCallRow>>(async ({ request }) => {
  const query = querySchema.parse(searchParamsToObject(request.url));
  return NextResponse.json(await listCalls(query), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
