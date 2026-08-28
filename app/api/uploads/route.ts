import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authedRoute } from '@/lib/api/respond';
import { db } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { AppError, badRequest } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { normalizeWaveform } from '@/services/media-processing';
import { loadAttachmentDto, storeAttachment } from '@/services/storage';
import type { AttachmentDTO } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('uploads');

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
/**
 * Reads the multipart body, buffering it before it is parsed.
 *
 * `request.formData()` on the streamed request fails for anything past a few
 * megabytes behind a proxy — "Failed to parse body as FormData" out of undici's
 * multipart parser — which made every video upload a 500 while a small photo
 * went through. The same parser handles a fully buffered body of the same size
 * without complaint, so the body is materialised first and parsed from memory.
 *
 * The route already buffers each file to a Buffer a few lines later, so this
 * costs no memory that was not about to be spent anyway. `MAX_UPLOAD_BYTES` is
 * checked against `content-length` *before* reading, so an oversized upload is
 * refused with a real message rather than after transferring the whole thing.
 */
async function readMultipart(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw badRequest('Uploads must be sent as multipart/form-data');
  }

  // Multipart framing adds boundaries and headers around the payload, so the
  // envelope is always a little larger than the file it carries.
  const declared = Number(request.headers.get('content-length') ?? '0');
  const ceiling = maxBytes + 1024 * 1024;
  if (Number.isFinite(declared) && declared > ceiling) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `That upload is ${Math.round(declared / 1024 / 1024)} MB. The limit is ${Math.floor(
        maxBytes / 1024 / 1024,
      )} MB.`,
    );
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > ceiling) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Files must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller`,
    );
  }

  // A body that arrives shorter than it claimed was truncated in transit, and
  // no parser can recover it. Saying so distinguishes a network problem from a
  // malformed request, which otherwise look identical from here.
  if (declared > 0 && body.byteLength < declared) {
    log.warn('Upload body truncated in transit', {
      declared,
      received: body.byteLength,
      missing: declared - body.byteLength,
    });
    throw badRequest(
      `The upload was cut short — ${Math.round(body.byteLength / 1024 / 1024)} MB of ` +
        `${Math.round(declared / 1024 / 1024)} MB arrived. Please try again.`,
    );
  }

  try {
    return await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch (cause) {
    log.warn('Multipart parse failed', {
      declared,
      received: body.byteLength,
      contentType,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    // A genuinely malformed envelope is the caller's problem, and reporting it
    // as INTERNAL sends people hunting for a server fault that is not there.
    throw badRequest('That upload could not be read. Please try again.', {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

export const POST = authedRoute<Record<string, never>, UploadBody>(
  async ({ request, user }) => {
    const form = await readMultipart(request, serverEnv().MAX_UPLOAD_BYTES);
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
