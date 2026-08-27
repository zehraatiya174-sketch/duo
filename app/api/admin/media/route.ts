import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, searchParamsToObject } from '@/lib/api/respond';
import { type MediaLibraryRow, listMediaLibrary } from '@/services/media-library';
import type { Page } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  group: z.enum(['photos', 'videos', 'documents', 'voice', 'other']).optional(),
  state: z.enum(['stored', 'disappearing', 'expired', 'purged', 'orphaned']).optional(),
});

/**
 * The media library.
 *
 * Metadata only — the service returns no storage key and no signed path, so
 * this route cannot hand back the contents of anybody's conversation.
 */
export const GET = adminRoute<Record<string, never>, Page<MediaLibraryRow>>(async ({ request }) => {
  const query = querySchema.parse(searchParamsToObject(request.url));
  return NextResponse.json(await listMediaLibrary(query), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
