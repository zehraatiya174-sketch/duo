import type { AttachmentKind } from '@prisma/client';

import { createLogger } from '@/lib/logger';

const log = createLogger('media-processing');

export interface ProcessInput {
  bytes: Buffer;
  mimeType: string;
  kind: AttachmentKind;
  /**
   * A frame the client lifted from a video. The server has no decoder, so this
   * is the only way a video gets a poster and a blur placeholder.
   */
  poster?: Buffer | null;
}

export interface ProcessedMedia {
  /** Possibly re-encoded payload. Falls back to the original on any failure. */
  bytes: Buffer;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: number[] | null;
  blurDataUrl: string | null;
  thumbnail: Buffer | null;
}

/** Images above this dimension are downscaled before storage. */
const MAX_IMAGE_DIMENSION = 2560;
const THUMBNAIL_SIZE = 480;
const BLUR_SIZE = 16;
/** Re-encoding a small image usually makes it bigger; skip those. */
const MIN_BYTES_TO_RECOMPRESS = 64 * 1024;

function passthrough(input: ProcessInput): ProcessedMedia {
  return {
    bytes: input.bytes,
    width: null,
    height: null,
    duration: null,
    waveform: null,
    blurDataUrl: null,
    thumbnail: null,
  };
}

interface Preview {
  thumbnail: Buffer | null;
  blurDataUrl: string | null;
}

const NO_PREVIEW: Preview = { thumbnail: null, blurDataUrl: null };

/**
 * Reduces one image to the two derivatives every bubble needs: a thumbnail the
 * grid can load instead of the original, and a blur placeholder small enough to
 * inline. Neither is worth failing an upload over, so both degrade to null.
 */
async function derivePreview(bytes: Buffer): Promise<Preview> {
  try {
    const sharp = (await import('sharp')).default;
    const source = (): ReturnType<typeof sharp> =>
      sharp(bytes, { failOn: 'none', animated: false }).rotate();

    const [thumbnail, blurBuffer] = await Promise.all([
      source()
        .resize({
          width: THUMBNAIL_SIZE,
          height: THUMBNAIL_SIZE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 70 })
        .toBuffer()
        .catch(() => null),
      source()
        .resize({ width: BLUR_SIZE, height: BLUR_SIZE, fit: 'inside' })
        .webp({ quality: 40 })
        .toBuffer()
        .catch(() => null),
    ]);

    return {
      thumbnail,
      blurDataUrl: blurBuffer ? `data:image/webp;base64,${blurBuffer.toString('base64')}` : null,
    };
  } catch (error) {
    log.warn('Preview generation failed', { error });
    return NO_PREVIEW;
  }
}

/**
 * Derives dimensions, thumbnails and blur placeholders, and compresses large
 * images. Video and audio metadata would need ffmpeg, which is a heavy runtime
 * dependency; the client measures those and sends them alongside the upload
 * instead (see `hooks/use-uploader.ts` and `app/api/uploads/route.ts`).
 */
export async function processMedia(input: ProcessInput): Promise<ProcessedMedia> {
  if (input.kind !== 'IMAGE' && input.kind !== 'STICKER') {
    // A video carries its own first frame; everything else has nothing to show.
    const preview = input.poster?.byteLength ? await derivePreview(input.poster) : NO_PREVIEW;
    return { ...passthrough(input), ...preview };
  }

  try {
    const sharp = (await import('sharp')).default;
    const image = sharp(input.bytes, { failOn: 'none', animated: false });
    const metadata = await image.metadata();

    const width = metadata.width ?? null;
    const height = metadata.height ?? null;

    const needsResize =
      (width !== null && width > MAX_IMAGE_DIMENSION) ||
      (height !== null && height > MAX_IMAGE_DIMENSION);
    const worthRecompressing = input.bytes.byteLength >= MIN_BYTES_TO_RECOMPRESS;

    let bytes = input.bytes;
    let finalWidth = width;
    let finalHeight = height;

    if (needsResize || worthRecompressing) {
      const pipeline = sharp(input.bytes, { failOn: 'none', animated: false })
        .rotate() // honour EXIF orientation, then drop the tag
        .resize({
          width: MAX_IMAGE_DIMENSION,
          height: MAX_IMAGE_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 });

      const result = await pipeline.toBuffer({ resolveWithObject: true });
      // Only keep the re-encode if it actually saved space.
      if (result.data.byteLength < input.bytes.byteLength || needsResize) {
        bytes = result.data;
        finalWidth = result.info.width;
        finalHeight = result.info.height;
      }
    }

    const preview = await derivePreview(input.bytes);

    return {
      bytes,
      width: finalWidth,
      height: finalHeight,
      duration: null,
      waveform: null,
      ...preview,
    };
  } catch (error) {
    // A corrupt or exotic image must not fail the upload — store it as-is.
    log.warn('Image processing failed; storing original bytes', { error });
    return passthrough(input);
  }
}

/**
 * Downsamples a peak array to a fixed bucket count for waveform rendering.
 * The client records peaks at whatever rate the AudioContext gives it; the UI
 * always draws the same number of bars.
 */
export function normalizeWaveform(peaks: readonly number[], buckets = 64): number[] {
  if (peaks.length === 0) return [];
  if (peaks.length <= buckets) {
    const max = Math.max(...peaks, 0.0001);
    return peaks.map((p) => Math.min(1, Math.max(0, p / max)));
  }

  const size = peaks.length / buckets;
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(peaks.length, Math.floor((i + 1) * size));
    let peak = 0;
    for (let j = start; j < end; j++) {
      const value = Math.abs(peaks[j] ?? 0);
      if (value > peak) peak = value;
    }
    out.push(peak);
  }

  const max = Math.max(...out, 0.0001);
  return out.map((p) => Math.min(1, Math.max(0, p / max)));
}
