// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import {
  CHUNK_SIZE,
  abortUpload,
  beginUpload,
  completeUpload,
  writePart,
} from '@/lib/uploads/session';

const ALICE = 'user-alice';
const BOB = 'user-bob';

/**
 * Distinguishable bytes: every part is filled with its own index, so a
 * reassembled file that is the right *length* but the wrong *order* still fails.
 */
function part(index: number, size: number): Buffer {
  return Buffer.alloc(size, index % 256);
}

/**
 * The registry is module state and each account may hold only a few sessions at
 * once, so a test that leaves one open would exhaust the cap for the next one.
 */
const opened: { uploadId: string; userId: string }[] = [];

afterEach(async () => {
  for (const { uploadId, userId } of opened.splice(0)) {
    await abortUpload(uploadId, userId).catch(() => undefined);
  }
});

async function start(totalBytes: number, userId = ALICE) {
  const session = await beginUpload({
    userId,
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    totalBytes,
  });
  opened.push({ uploadId: session.uploadId, userId });
  return session;
}

describe('chunked upload sessions', () => {
  it('reassembles parts sent out of order', async () => {
    const size = CHUNK_SIZE * 2 + 1024;
    const { uploadId, totalParts } = await start(size);
    expect(totalParts).toBe(3);

    // Deliberately backwards. Parts are written at their offset, so arrival
    // order must not matter.
    await writePart(uploadId, ALICE, 2, part(2, 1024));
    await writePart(uploadId, ALICE, 0, part(0, CHUNK_SIZE));
    const progress = await writePart(uploadId, ALICE, 1, part(1, CHUNK_SIZE));
    expect(progress).toEqual({ received: 3, totalParts: 3 });

    const assembled = await completeUpload(uploadId, ALICE);
    expect(assembled.bytes.byteLength).toBe(size);
    expect(assembled.fileName).toBe('clip.mp4');

    expect(assembled.bytes.subarray(0, CHUNK_SIZE).every((b) => b === 0)).toBe(true);
    expect(assembled.bytes.subarray(CHUNK_SIZE, CHUNK_SIZE * 2).every((b) => b === 1)).toBe(true);
    expect(assembled.bytes.subarray(CHUNK_SIZE * 2).every((b) => b === 2)).toBe(true);
  });

  it('treats a resent part as an overwrite, not an append', async () => {
    const { uploadId } = await start(2048);

    // A retry after a failed attempt sends the same index again.
    await writePart(uploadId, ALICE, 0, part(9, 2048));
    const progress = await writePart(uploadId, ALICE, 0, part(7, 2048));
    expect(progress.received).toBe(1);

    const assembled = await completeUpload(uploadId, ALICE);
    expect(assembled.bytes.byteLength).toBe(2048);
    expect(assembled.bytes.every((b) => b === 7)).toBe(true);
  });

  it('carries the client measurements through to completion', async () => {
    const { uploadId } = await beginUpload({
      userId: ALICE,
      fileName: 'note.webm',
      mimeType: 'audio/webm',
      totalBytes: 16,
      metadata: { duration: 4.5, width: 1920, height: 1080 },
      waveform: [0, 0.5, 1],
    });

    await writePart(uploadId, ALICE, 0, part(0, 16));
    const assembled = await completeUpload(uploadId, ALICE);

    expect(assembled.metadata).toEqual({ duration: 4.5, width: 1920, height: 1080 });
    expect(assembled.waveform).toEqual([0, 0.5, 1]);
  });

  it('refuses to complete while a part is missing', async () => {
    const { uploadId } = await start(CHUNK_SIZE * 2);
    await writePart(uploadId, ALICE, 0, part(0, CHUNK_SIZE));

    await expect(completeUpload(uploadId, ALICE)).rejects.toThrow(/1 of 2 parts/);
  });

  it('rejects a part that would run past the declared size', async () => {
    const { uploadId } = await start(1024);
    await expect(writePart(uploadId, ALICE, 0, part(0, 2048))).rejects.toThrow(AppError);
  });

  it('rejects an index outside the upload', async () => {
    const { uploadId } = await start(1024);
    await expect(writePart(uploadId, ALICE, 5, part(0, 16))).rejects.toThrow(/outside this upload/);
  });

  it('rejects a part larger than the chunk size', async () => {
    const { uploadId } = await start(CHUNK_SIZE * 3);
    await expect(writePart(uploadId, ALICE, 0, part(0, CHUNK_SIZE + 1))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it("hides another account's session rather than reporting it as forbidden", async () => {
    const { uploadId } = await start(1024, ALICE);

    // NOT_FOUND, not FORBIDDEN: a wrong owner must not be able to tell a live
    // upload id from one that never existed.
    await expect(writePart(uploadId, BOB, 0, part(0, 16))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(completeUpload(uploadId, BOB)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Still usable by its owner.
    await writePart(uploadId, ALICE, 0, part(0, 1024));
    await expect(completeUpload(uploadId, ALICE)).resolves.toBeDefined();
  });

  it('rejects a malformed id without looking it up', async () => {
    await expect(writePart('../../etc/passwd', ALICE, 0, part(0, 16))).rejects.toThrow(
      /Malformed upload id/,
    );
  });

  it('closes the session once it completes', async () => {
    const { uploadId } = await start(1024);
    await writePart(uploadId, ALICE, 0, part(0, 1024));
    await completeUpload(uploadId, ALICE);

    await expect(completeUpload(uploadId, ALICE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('releases an aborted session', async () => {
    const { uploadId } = await start(1024);
    await abortUpload(uploadId, ALICE);

    await expect(writePart(uploadId, ALICE, 0, part(0, 16))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('caps how many uploads one account can have open', async () => {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => start(1024, BOB)));

    await expect(start(1024, BOB)).rejects.toMatchObject({ code: 'CONFLICT' });

    // A finished upload frees the slot.
    await abortUpload(sessions[0]!.uploadId, BOB);
    await expect(start(1024, BOB)).resolves.toBeDefined();
  });
});
