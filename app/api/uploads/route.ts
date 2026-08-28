import { NextResponse } from 'next/server';

import { authedRoute } from '@/lib/api/respond';
import { serverEnv } from '@/lib/env';
import { AppError, badRequest } from '@/lib/errors';
import type { AttachmentDTO } from '@/types/models';

import { extrasFromForm, ingestUpload, readMultipart } from './ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UploadBody {
  attachments: AttachmentDTO[];
}

/**
 * Single-request upload.
 *
 * Handles anything small enough to send in one go. Larger files use the chunked
 * session under `init` / `part` / `complete`, which is not subject to whatever
 * body limit the proxy in front of the app imposes.
 *
 * Attachments are created detached (`messageId: null`) and are only bound to a
 * message when it is sent. That two-step flow is what lets the composer show
 * upload progress before the user has finished typing, and
 * `pruneOrphanAttachments` reclaims anything that never gets attached.
 */
export const POST = authedRoute<Record<string, never>, UploadBody>(
  async ({ request, user }) => {
    const maxBytes = serverEnv().MAX_UPLOAD_BYTES;

    const form = await readMultipart(request, maxBytes);
    const files = form.getAll('files').filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) throw badRequest('No files were uploaded');
    if (files.length > 10) throw badRequest('Upload at most 10 files at a time');

    const extras = extrasFromForm(form);

    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > maxBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `That upload is too large. The limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
      );
    }

    const attachments: AttachmentDTO[] = [];
    for (const file of files) {
      attachments.push(
        await ingestUpload({
          uploaderId: user.id,
          fileName: file.name,
          mimeType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
          extras,
        }),
      );
    }

    return NextResponse.json<UploadBody>({ attachments }, { status: 201 });
  },
  { rateLimit: 'upload' },
);
