import { api, uploadWithProgress } from '@/lib/api/client';
import { AppError } from '@/lib/errors';
import { backoffDelay, isAbortError, sleep } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';

/**
 * The browser half of chunked upload. (`./session` is the server half and imports
 * `node:fs` — the two never meet.)
 *
 * Above a few megabytes a single request stops being a safe way to move a file:
 * a proxy caps the body, a phone changes network mid-transfer, and either way
 * the whole upload restarts from zero. Slicing it means a failure costs one
 * slice, and the parts are small enough that no limit in the path is near being
 * reached.
 */

/**
 * Files larger than this go part-by-part.
 *
 * Below it the extra three round trips cost more than they save, and a photo
 * that uploads in one request should keep doing so.
 */
export const CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024;

/**
 * Parts in flight at once.
 *
 * Two, not more. One stream leaves the uplink idle for a round trip between
 * parts; three does not upload meaningfully faster than two — a single TCP
 * stream already fills a typical home uplink — but each extra stream deepens
 * the queue on that uplink, and everything else sharing it waits behind that
 * queue. In this app "everything else" is the realtime socket, whose heartbeat
 * was being delayed past its timeout, dropping the connection partway through
 * every large upload.
 */
const PART_CONCURRENCY = 2;

/**
 * Extra attempts made without asking.
 *
 * A dropped connection mid-upload is common on mobile and costs nothing to try
 * again; surfacing it as a failure the sender has to notice and press is worse
 * than simply retrying.
 */
export const AUTO_RETRIES = 2;

/**
 * Failures that will recur identically however many times the same bytes are
 * sent, so retrying only postpones the message the sender needs to read.
 */
const FINAL_ERROR_CODES = new Set([
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_AUTHORIZED_ACCOUNT',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
]);

export function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  return !(error instanceof AppError) || !FINAL_ERROR_CODES.has(error.code);
}

/** What the client measured and the server cannot recover from the bytes. */
export interface ChunkedExtras {
  waveform?: number[];
  duration?: number;
  width?: number;
  height?: number;
}

interface SessionInfo {
  uploadId: string;
  chunkSize: number;
  totalParts: number;
}

interface CompleteResponse {
  attachments: AttachmentDTO[];
}

export interface ChunkedHandlers {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * Progress stops here until the server answers `complete`.
 *
 * Assembling, encrypting and thumbnailing a large video is not instant, and a
 * bar that sat at 100% through all of it would look stuck at the one moment the
 * user is waiting hardest.
 */
const TRANSFER_SHARE = 96;

/**
 * Runs `worker` over `count` indices, `limit` at a time.
 *
 * The first failure stops the remaining indices from starting — without the
 * shared flag, `Promise.all` would reject while the other workers carried on
 * uploading parts of a file that is already lost.
 */
async function pool(
  count: number,
  limit: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;

  const run = async (): Promise<void> => {
    while (failure === null) {
      const index = next;
      next += 1;
      if (index >= count) return;
      try {
        await worker(index);
      } catch (error) {
        failure = error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, count) }, run));
  if (failure !== null) throw failure;
}

/**
 * Uploads one file as a session of parts and returns the finished attachment.
 *
 * Retries are per part rather than per file, which is the whole point: a
 * connection that drops at 90% resends 5 MB, not 200.
 */
export async function uploadChunked(
  file: File,
  extras: ChunkedExtras,
  handlers: ChunkedHandlers = {},
): Promise<AttachmentDTO> {
  const { onProgress, signal } = handlers;

  const session = await api.post<SessionInfo>('/api/uploads/init', {
    body: {
      fileName: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      totalBytes: file.size,
      ...extras,
    },
    ...(signal ? { signal } : {}),
  });

  // Progress is reported per part, so the total has to be reassembled from the
  // pieces currently in flight as well as the ones already done.
  const loaded = new Map<number, number>();
  const report = (): void => {
    let sum = 0;
    for (const value of loaded.values()) sum += value;
    onProgress?.(Math.min(TRANSFER_SHARE, Math.round((sum / file.size) * TRANSFER_SHARE)));
  };

  try {
    await pool(session.totalParts, PART_CONCURRENCY, async (index) => {
      const start = index * session.chunkSize;
      const blob = file.slice(start, Math.min(start + session.chunkSize, file.size));

      for (let attempt = 0; ; attempt += 1) {
        const form = new FormData();
        form.append('uploadId', session.uploadId);
        form.append('index', String(index));
        form.append('chunk', blob, `${index}.part`);

        try {
          await uploadWithProgress('/api/uploads/part', form, {
            onProgress: (percent) => {
              loaded.set(index, (percent / 100) * blob.size);
              report();
            },
            ...(signal ? { signal } : {}),
          });
          // Trust the completed request over the last progress event, which
          // stops short of the full size often enough to strand the bar.
          loaded.set(index, blob.size);
          report();
          return;
        } catch (error) {
          // A retry re-sends from zero, so its progress must not stack on top
          // of what the failed attempt had already reported.
          loaded.set(index, 0);
          report();

          if (attempt >= AUTO_RETRIES || !isRetryable(error)) throw error;
          await sleep(backoffDelay(attempt, 500, 4000));
          if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
        }
      }
    });

    const response = await api.post<CompleteResponse>('/api/uploads/complete', {
      body: { uploadId: session.uploadId },
      ...(signal ? { signal } : {}),
    });

    const attachment = response.attachments[0];
    if (!attachment) throw new Error('The upload returned no attachment');

    onProgress?.(100);
    return attachment;
  } catch (error) {
    // Best effort: release the server's temp file now instead of leaving it for
    // the sweep. A failure here must not replace the error being thrown.
    void api
      .delete('/api/uploads/init', { body: { uploadId: session.uploadId } })
      .catch(() => undefined);
    throw error;
  }
}
