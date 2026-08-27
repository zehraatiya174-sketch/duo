import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/api/respond';
import { verifyMediaSignature } from '@/lib/crypto';
import { db } from '@/lib/db';
import { AppError, forbidden, notFound } from '@/lib/errors';
import { requireUser } from '@/lib/auth/session';
import { createLogger } from '@/lib/logger';
import { enforceRateLimit } from '@/lib/rate-limit';
import { assertMayReadAttachment } from '@/services/ephemeral';
import { loadAttachment } from '@/services/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:media');

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range` header.
 *
 * Video is unplayable in Safari without this, and unseekable everywhere else:
 * the element asks for `bytes=0-1` first and abandons any source that answers
 * with the whole file. Only one range is honoured — multipart/byteranges buys
 * nothing for media playback and doubles the response assembly.
 *
 * Returns `null` when the header is absent or not a byte range, and
 * `'unsatisfiable'` when it names bytes the object does not have.
 */
function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  const hasStart = rawStart !== '';
  const hasEnd = rawEnd !== '';
  if (!hasStart && !hasEnd) return 'unsatisfiable';

  // `bytes=-500` means the *last* 500 bytes, not "up to byte 500".
  const start = hasStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd));
  const end = hasStart ? (hasEnd ? Math.min(Number(rawEnd), size - 1) : size - 1) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end };
}

/**
 * The only way media ever reaches the browser.
 *
 * Storage keys are never exposed and provider URLs are never public, so every
 * read is mediated here. A request must satisfy three independent checks:
 *
 *  1. a valid session (the signature alone is not authorisation),
 *  2. an unexpired HMAC signature bound to *this* user and attachment, and
 *  3. the ephemeral gate — sealed or purged content is unreadable even with a
 *     perfectly valid signature.
 *
 * Because the signature is user-bound, a URL copied out of one person's browser
 * is useless in the other's.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  try {
    const { attachmentId } = await context.params;
    const url = new URL(request.url);

    const exp = Number.parseInt(url.searchParams.get('exp') ?? '', 10);
    const signature = url.searchParams.get('sig');
    const disposition = url.searchParams.get('d');
    const variant = url.searchParams.get('v') ?? undefined;

    if (
      !Number.isFinite(exp) ||
      !signature ||
      (disposition !== 'inline' && disposition !== 'attachment')
    ) {
      throw forbidden('Malformed media link');
    }

    const user = await requireUser();
    await enforceRateLimit('mediaRead', user.id);

    const verification = verifyMediaSignature(
      { attachmentId, userId: user.id, exp, disposition, variant },
      signature,
    );

    if (!verification.valid) {
      // Expiry and forgery are reported identically: telling a caller that a
      // signature was merely stale is a probing oracle.
      if (verification.reason === 'bad-signature') {
        log.warn('Rejected media signature', { attachmentId, userId: user.id });
      }
      throw forbidden('This media link has expired');
    }

    // Re-checks ephemeral state at read time, so a signature minted while a
    // view-once message was open cannot outlive the view itself.
    await assertMayReadAttachment(user.id, attachmentId);

    const attachment = await db.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, purgedAt: true, byteSize: true, kind: true },
    });
    if (!attachment) throw notFound('Attachment not found');
    if (attachment.purgedAt) throw new AppError('GONE', 'This media has been destroyed');

    const loaded = await loadAttachment(attachmentId, variant);

    // RFC 5987 encoding keeps non-ASCII file names intact without allowing a
    // quote or newline to break out of the header.
    const safeName = loaded.fileName.replace(/["\\\r\n]/g, '_');
    const encodedName = encodeURIComponent(loaded.fileName);

    const size = loaded.bytes.byteLength;
    const range = parseRange(request.headers.get('range'), size);

    const headers: Record<string, string> = {
      'Content-Type': loaded.mimeType,
      'Content-Disposition': `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      // Advertised even on a full response: a player only attempts to seek once
      // it has been told the source supports it.
      'Accept-Ranges': 'bytes',
      // Private and uncached: a shared cache must never hold decrypted media,
      // and a stale copy would survive an ephemeral purge.
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    };

    if (range === 'unsatisfiable') {
      return new NextResponse(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    }

    // One entry per *download*, not per byte range: a seeking player issues
    // dozens of requests for the same file and each would otherwise be an
    // audit row claiming the media was saved again.
    if (disposition === 'attachment' && !range) {
      await db.auditLog.create({
        data: {
          userId: user.id,
          action: 'ATTACHMENT_DOWNLOADED',
          metadata: { attachmentId, variant: variant ?? 'original' },
        },
      });
    }

    // The object is fetched and decrypted whole either way — AES-GCM
    // authenticates the entire payload, so there is no partial plaintext to
    // read — but answering with 206 is what makes the element seek.
    const slice = range
      ? loaded.bytes.subarray(range.start, range.end + 1)
      : loaded.bytes;
    const body = new Uint8Array(slice);

    return new NextResponse(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'Content-Length': String(body.byteLength),
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
