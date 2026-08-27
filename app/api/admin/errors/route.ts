import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, searchParamsToObject } from '@/lib/api/respond';
import { type ErrorLogRow, listErrorLogs } from '@/services/diagnostics';
import type { Page } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  severity: z.enum(['WARN', 'ERROR', 'FATAL']).optional(),
  scope: z.string().max(120).optional(),
});

/** Server-side faults, newest first. Contexts are redacted before they land. */
export const GET = adminRoute<Record<string, never>, Page<ErrorLogRow>>(async ({ request }) => {
  const query = querySchema.parse(searchParamsToObject(request.url));
  return NextResponse.json(await listErrorLogs(query), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
