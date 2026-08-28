import { NextResponse } from 'next/server';

import { authedRoute } from '@/lib/api/respond';
import { badRequest } from '@/lib/errors';
import { CHUNK_SIZE, writePart } from '@/lib/uploads/session';

import { readMultipart } from '../ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface PartAccepted {
  received: number;
  totalParts: number;
}

/**
 * Accepts one slice of a chunked upload.
 *
 * Parts may arrive in any order and any part may be sent again: the session
 * writes each one at its own byte offset, so a retry overwrites rather than
 * appends. That is what makes a dropped connection cost one 5 MB slice instead
 * of the whole video.
 */
export const POST = authedRoute<Record<string, never>, PartAccepted>(
  async ({ request, user }) => {
    const form = await readMultipart(request, CHUNK_SIZE);

    const uploadId = form.get('uploadId');
    const rawIndex = form.get('index');
    const chunk = form.get('chunk');

    if (typeof uploadId !== 'string') throw badRequest('The part is missing its upload id');
    if (typeof rawIndex !== 'string') throw badRequest('The part is missing its index');
    if (!(chunk instanceof File)) throw badRequest('The part carried no data');

    const index = Number(rawIndex);
    const bytes = Buffer.from(await chunk.arrayBuffer());

    return NextResponse.json<PartAccepted>(await writePart(uploadId, user.id, index, bytes));
  },
  { rateLimit: 'uploadPart' },
);
