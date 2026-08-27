import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authedRoute } from '@/lib/api/respond';
import { db } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { AppError, badRequest } from '@/lib/errors';
import { normalizeWaveform } from '@/services/media-processing';
import { loadAttachmentDto, storeAttachment } from '@/services/storage';
import type { AttachmentDTO } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Peaks captured by the recorder, so the waveform matches what the user saw. */
const waveformSchema = z.array(z.number().min(0).max(1)).max(4096);

interface UploadBody {
  attachments: AttachmentDTO[];
}

/**
 * Multipart upload.
 *
 * Attachments are created detached (`messageId: null`) and are only bound to a
 * message when it is sent. That two-step flow is what lets the composer show
 * upload progress before the user has finished typing, and `pruneOrphanAttachments`
 * reclaims anything that never gets attached.
 */
export const POST = authedRoute<Record<string, never>, UploadBody>(
  async ({ request, user }) => {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw badRequest('Uploads must be sent as multipart/form-data');
    }

    const form = await request.formData();
    const files = form.getAll('files').filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) throw badRequest('No files were uploaded');
    if (files.length > 10) throw badRequest('Upload at most 10 files at a time');

    // Waveforms are captured client-side during recording; the server cannot
    // recover them from an encoded blob without decoding the whole file.
    const rawWaveform = form.get('waveform');
    const waveform =
      typeof rawWaveform === 'string' && rawWaveform.length > 0
        ? normalizeWaveform(waveformSchema.parse(JSON.parse(rawWaveform)))
        : null;

    const rawDuration = form.get('duration');
    const duration =
      typeof rawDuration === 'string' && rawDuration.length > 0
        ? z.coerce
            .number()
            .positive()
            .max(60 * 60 * 6)
            .parse(rawDuration)
        : null;

    const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > maxBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `That upload is too large. The limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
      );
    }

    const attachments: AttachmentDTO[] = [];

    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      const stored = await storeAttachment({
        uploaderId: user.id,
        fileName: file.name || 'upload',
        mimeType: file.type || 'application/octet-stream',
        bytes,
      });

      if (waveform || duration !== null) {
        await db.attachment.update({
          where: { id: stored.id },
          data: {
            ...(waveform ? { waveform } : {}),
            ...(duration !== null ? { duration } : {}),
          },
        });
      }

      const dto = await loadAttachmentDto(stored.id, user.id);
      attachments.push(dto);

      await db.auditLog.create({
        data: {
          userId: user.id,
          action: 'ATTACHMENT_UPLOADED',
          metadata: { attachmentId: dto.id, kind: dto.kind, byteSize: dto.byteSize },
        },
      });
    }

    return NextResponse.json<UploadBody>({ attachments }, { status: 201 });
  },
  { rateLimit: 'upload' },
);
