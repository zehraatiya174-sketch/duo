import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authedRoute } from '@/lib/api/respond';
import { serverEnv } from '@/lib/env';
import { AppError, fromZodError } from '@/lib/errors';
import { abortUpload, beginUpload } from '@/lib/uploads/session';
import { assertMimeAllowed } from '@/services/storage';

import { uploadExtrasSchema } from '../ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const startSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    totalBytes: z.number().int().positive(),
  })
  .merge(uploadExtrasSchema);

const abortSchema = z.object({ uploadId: z.string() });

export interface UploadSessionInfo {
  uploadId: string;
  chunkSize: number;
  totalParts: number;
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw fromZodError(parsed.error);
  return parsed.data;
}

/**
 * Opens a chunked upload.
 *
 * Everything that can reject the file is checked here, before a single byte is
 * sent: the type it claims and the size it declares. Discovering at part 80 of
 * 80 that the server was never going to accept a `.exe` wastes the whole
 * transfer, and on a phone connection that is the difference between an
 * instant error and several minutes of it.
 *
 * The dimensions and duration the client measured travel with this request
 * rather than the last one, so `complete` needs to carry nothing but the id.
 */
export const POST = authedRoute<Record<string, never>, UploadSessionInfo>(
  async ({ request, user }) => {
    const input = await body(request, startSchema);

    const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
    if (input.totalBytes > maxBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `That file is ${Math.round(input.totalBytes / 1024 / 1024)} MB. The limit is ${Math.floor(
          maxBytes / 1024 / 1024,
        )} MB.`,
      );
    }

    assertMimeAllowed(input.mimeType, input.fileName);

    const session = await beginUpload({
      userId: user.id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      totalBytes: input.totalBytes,
      metadata: {
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
      },
      ...(input.waveform ? { waveform: input.waveform } : {}),
    });

    return NextResponse.json<UploadSessionInfo>(session, { status: 201 });
  },
  { rateLimit: 'upload' },
);

/**
 * Cancels a session, so an abandoned upload releases its temp file now rather
 * than when the sweep gets to it. Best-effort by nature — the client fires this
 * as it navigates away — so an id that has already expired is not an error.
 */
export const DELETE = authedRoute<Record<string, never>, { aborted: true }>(
  async ({ request, user }) => {
    const { uploadId } = await body(request, abortSchema);
    await abortUpload(uploadId, user.id).catch(() => undefined);
    return NextResponse.json({ aborted: true as const });
  },
);
