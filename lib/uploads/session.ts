import { open, mkdir, rm, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { randomId } from '@/lib/crypto';
import { AppError, badRequest, notFound } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('uploads:session');

/**
 * Chunked uploads.
 *
 * A single request cannot carry a large video: a proxy in front of the app
 * caps a request body (Cloudflare drops one near 100MB), and Next buffers the
 * body again for any route its middleware matches. Splitting the file into
 * parts keeps every individual request small enough that neither limit is
 * anywhere near reached, and it makes a failure cost one part rather than the
 * whole upload.
 *
 * Parts are written straight to a temp file at their byte offset rather than
 * accumulated in memory, so a 400MB upload costs one part of RAM, not four
 * hundred megabytes of it. Positional writes also mean parts may arrive in any
 * order and any part may be retried on its own.
 *
 * State is process-local on purpose. The deployment runs exactly one instance —
 * the same constraint that forbids a second Socket.IO replica — so a Map is the
 * whole truth. A restart loses in-flight sessions, which costs a re-upload and
 * nothing else; persisting them would mean a schema change to survive an event
 * that already interrupts the user.
 */

/**
 * 5 MB.
 *
 * Comfortably under both limits above with room for the multipart envelope,
 * while keeping the request count sane — a 400MB video is 80 parts, not 800.
 */
export const CHUNK_SIZE = 5 * 1024 * 1024;

/** Long enough for a slow phone to finish; short enough to reclaim disk. */
const SESSION_TTL_MS = 30 * 60_000;

/** Bounds the registry regardless of what a client does. */
const MAX_SESSIONS = 32;

export interface UploadSession {
  id: string;
  userId: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  totalParts: number;
  received: Set<number>;
  filePath: string;
  handle: FileHandle;
  createdAt: number;
  metadata?: { width?: number; height?: number; duration?: number };
  /**
   * Carried from `init` rather than `complete` so the last request in the
   * sequence needs nothing but the id — there is no point re-sending peaks the
   * server has already been told about.
   */
  waveform?: number[];
}

const sessions = new Map<string, UploadSession>();

/**
 * `randomId` returns base64url, so anything outside this alphabet cannot name a
 * session we created. It is also the reason an id is safe to put in a path: the
 * alphabet contains no separator, no dot, and no backslash, so `..` cannot be
 * spelled in it.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function directory(): string {
  return path.join(os.tmpdir(), 'duo-uploads');
}

async function discard(session: UploadSession): Promise<void> {
  sessions.delete(session.id);
  try {
    await session.handle.close();
  } catch {
    // Already closed, or the handle died with the process that owned it.
  }
  await rm(session.filePath, { force: true }).catch(() => undefined);
}

/** Drops sessions that were started and never finished. */
async function sweep(): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const session of [...sessions.values()]) {
    if (session.createdAt < cutoff) {
      log.info('Discarding a stale upload session', { id: session.id, userId: session.userId });
      await discard(session);
    }
  }
}

export interface BeginInput {
  userId: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  metadata?: { width?: number; height?: number; duration?: number };
  waveform?: number[];
}

export async function beginUpload(input: BeginInput): Promise<{
  uploadId: string;
  chunkSize: number;
  totalParts: number;
}> {
  await sweep();

  // One person cannot legitimately have many uploads in flight, and an
  // unbounded registry is a way to fill the disk.
  const mine = [...sessions.values()].filter((s) => s.userId === input.userId);
  if (mine.length >= 4 || sessions.size >= MAX_SESSIONS) {
    throw new AppError('CONFLICT', 'Too many uploads in progress. Finish or cancel one first.');
  }

  const id = randomId(16);
  const dir = directory();
  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${id}.part`);
  const handle = await open(filePath, 'w+');

  const session: UploadSession = {
    id,
    userId: input.userId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    totalBytes: input.totalBytes,
    totalParts: Math.max(1, Math.ceil(input.totalBytes / CHUNK_SIZE)),
    received: new Set(),
    filePath,
    handle,
    createdAt: Date.now(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.waveform ? { waveform: input.waveform } : {}),
  };

  sessions.set(id, session);
  log.info('Upload session opened', {
    id,
    userId: input.userId,
    totalBytes: input.totalBytes,
    totalParts: session.totalParts,
  });

  return { uploadId: id, chunkSize: CHUNK_SIZE, totalParts: session.totalParts };
}

/**
 * Looks a session up, refusing anything that is not the owner's.
 *
 * The id is unguessable, but ownership is checked anyway: an id can leak
 * through a log or a shared screen, and "hard to guess" is not an authorisation
 * model.
 */
function require_(uploadId: string, userId: string): UploadSession {
  if (!ID_PATTERN.test(uploadId)) throw badRequest('Malformed upload id');

  const session = sessions.get(uploadId);
  // Same answer either way: a wrong owner must not be able to tell a live
  // session from one that never existed.
  if (!session || session.userId !== userId) {
    throw notFound('That upload has expired. Please start it again.');
  }
  return session;
}

export async function writePart(
  uploadId: string,
  userId: string,
  index: number,
  chunk: Buffer,
): Promise<{ received: number; totalParts: number }> {
  const session = require_(uploadId, userId);

  if (!Number.isInteger(index) || index < 0 || index >= session.totalParts) {
    throw badRequest(`Part ${index} is outside this upload`);
  }
  if (chunk.byteLength > CHUNK_SIZE) {
    throw new AppError('PAYLOAD_TOO_LARGE', `A part may be at most ${CHUNK_SIZE} bytes`);
  }

  const offset = index * CHUNK_SIZE;
  if (offset + chunk.byteLength > session.totalBytes) {
    throw badRequest('That part would run past the size this upload declared');
  }

  // Positional write: parts may arrive out of order, and re-sending one is
  // idempotent rather than corrupting.
  await session.handle.write(chunk, 0, chunk.byteLength, offset);
  session.received.add(index);

  return { received: session.received.size, totalParts: session.totalParts };
}

export interface AssembledUpload {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  metadata: UploadSession['metadata'];
  waveform: UploadSession['waveform'];
}

/**
 * Closes the session and hands back the reassembled file.
 *
 * The caller is responsible for storing it; this only guarantees the bytes are
 * complete. The temp file is removed whether that succeeds or not — a failed
 * store must not leave the upload on disk.
 */
export async function completeUpload(
  uploadId: string,
  userId: string,
): Promise<AssembledUpload> {
  const session = require_(uploadId, userId);

  if (session.received.size !== session.totalParts) {
    const missing = session.totalParts - session.received.size;
    throw badRequest(`${missing} of ${session.totalParts} parts are still missing`);
  }

  try {
    const written = await stat(session.filePath);
    if (written.size !== session.totalBytes) {
      throw badRequest(
        `The assembled file is ${written.size} bytes but ${session.totalBytes} were declared`,
      );
    }

    const bytes = Buffer.alloc(session.totalBytes);
    await session.handle.read(bytes, 0, session.totalBytes, 0);

    return {
      fileName: session.fileName,
      mimeType: session.mimeType,
      bytes,
      metadata: session.metadata,
      waveform: session.waveform,
    };
  } finally {
    await discard(session);
  }
}

/** Explicit cancel, so an abandoned upload frees its disk immediately. */
export async function abortUpload(uploadId: string, userId: string): Promise<void> {
  const session = require_(uploadId, userId);
  await discard(session);
}
