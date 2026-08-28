import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authedRoute } from '@/lib/api/respond';
import { fromZodError } from '@/lib/errors';
import { completeUpload } from '@/lib/uploads/session';
import type { AttachmentDTO } from '@/types/models';

import { ingestUpload } from '../ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ uploadId: z.string() });

interface UploadBody {
  attachments: AttachmentDTO[];
}

/**
 * Finishes a chunked upload.
 *
 * Returns the same shape as the single-request route so the composer does not
 * care which path a file took to get here.
 */
export const POST = authedRoute<Record<string, never>, UploadBody>(
  async ({ request, user }) => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw fromZodError(parsed.error);

    const assembled = await completeUpload(parsed.data.uploadId, user.id);

    const attachment = await ingestUpload({
      uploaderId: user.id,
      fileName: assembled.fileName,
      mimeType: assembled.mimeType,
      bytes: assembled.bytes,
      extras: {
        ...(assembled.metadata?.width !== undefined ? { width: assembled.metadata.width } : {}),
        ...(assembled.metadata?.height !== undefined ? { height: assembled.metadata.height } : {}),
        ...(assembled.metadata?.duration !== undefined
          ? { duration: assembled.metadata.duration }
          : {}),
        ...(assembled.waveform ? { waveform: assembled.waveform } : {}),
      },
    });

    return NextResponse.json<UploadBody>({ attachments: [attachment] }, { status: 201 });
  },
  { rateLimit: 'uploadPart' },
);
