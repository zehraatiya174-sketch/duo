import { z } from 'zod';

import { db } from '@/lib/db';
import { AppError, badRequest } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { normalizeWaveform } from '@/services/media-processing';
import { loadAttachmentDto, storeAttachment } from '@/services/storage';
import type { AttachmentDTO } from '@/types/models';

/**
 * The step both upload routes share.
 *
 * A file arrives either as one request (`/api/uploads`) or as parts reassembled
 * from a session (`/api/uploads/complete`). Everything after "here are the
 * bytes" is identical, and it lives here so the two paths cannot drift into
 * storing the same video differently depending on its size.
 */

const log = createLogger('uploads');

/** Peaks captured by the recorder, so the waveform matches what the user saw. */
const waveformSchema = z.array(z.number().min(0).max(1)).max(4096);

const SIX_HOURS_IN_SECONDS = 60 * 60 * 6;
/** Beyond any real recording, and far short of a dimension that could overflow. */
const MAX_DIMENSION = 16_384;

/**
 * What the client measured and the server cannot recover.
 *
 * A waveform would require decoding the whole file; a video's dimensions and
 * running time are readable only from a container the recorder has finished
 * writing, which is often not the case for a clip that was just captured.
 */
export const uploadExtrasSchema = z.object({
  waveform: waveformSchema.optional(),
  duration: z.number().positive().max(SIX_HOURS_IN_SECONDS).optional(),
  width: z.number().int().positive().max(MAX_DIMENSION).optional(),
  height: z.number().int().positive().max(MAX_DIMENSION).optional(),
});

export type UploadExtras = z.infer<typeof uploadExtrasSchema>;

/**
 * Reads the same fields out of a multipart body, where every value is a string.
 *
 * Coerced rather than parsed strictly, because the single-request route carries
 * them as form fields alongside the file itself.
 */
export function extrasFromForm(form: FormData): UploadExtras {
  const text = (key: string): string | undefined => {
    const value = form.get(key);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const rawWaveform = text('waveform');

  return uploadExtrasSchema.parse({
    ...(rawWaveform ? { waveform: JSON.parse(rawWaveform) as unknown } : {}),
    ...(text('duration') ? { duration: Number(text('duration')) } : {}),
    ...(text('width') ? { width: Number(text('width')) } : {}),
    ...(text('height') ? { height: Number(text('height')) } : {}),
  });
}

/**
 * Buffers a multipart body before parsing it.
 *
 * `request.formData()` on the streamed request fails for anything past a few
 * megabytes behind a proxy — "Failed to parse body as FormData" out of undici's
 * multipart parser — which made every video upload a 500 while a small photo
 * went through. The same parser handles a fully buffered body of the same size
 * without complaint, so the body is materialised first and parsed from memory.
 *
 * `maxBytes` is checked against `content-length` *before* reading, so an
 * oversized upload is refused with a real message rather than after
 * transferring the whole thing.
 */
export async function readMultipart(request: Request, maxBytes: number): Promise<FormData> {
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

export interface IngestInput {
  uploaderId: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  extras: UploadExtras;
}

/**
 * Turns bytes into a stored attachment and returns it as the client sees it.
 *
 * No audit row is written here: `storeAttachment` already records
 * `ATTACHMENT_UPLOADED` as part of persisting the file, and logging it again
 * from the route would double every upload in the admin trail.
 */
export async function ingestUpload(input: IngestInput): Promise<AttachmentDTO> {
  const { extras } = input;

  const stored = await storeAttachment({
    uploaderId: input.uploaderId,
    fileName: input.fileName || 'upload',
    mimeType: input.mimeType || 'application/octet-stream',
    bytes: input.bytes,
    metadata: {
      ...(extras.width !== undefined ? { width: extras.width } : {}),
      ...(extras.height !== undefined ? { height: extras.height } : {}),
      ...(extras.duration !== undefined ? { duration: extras.duration } : {}),
    },
  });

  // Dimensions and duration are handed to `storeAttachment` above, which
  // prefers them over anything it decodes. Only the waveform has to be written
  // afterwards, because it is derived during processing rather than accepted.
  if (extras.waveform?.length) {
    await db.attachment.update({
      where: { id: stored.id },
      data: { waveform: normalizeWaveform(extras.waveform) },
    });
  }

  return loadAttachmentDto(stored.id, input.uploaderId);
}
