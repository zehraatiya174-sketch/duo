/**
 * Client-side image preparation.
 *
 * Photographs straight off a phone are routinely 4–12 MB, and almost none of
 * that survives being displayed in a chat bubble. Downscaling before the upload
 * saves the sender's bandwidth, the server's storage and — because the file is
 * encrypted at rest — a proportional amount of CPU on every later read.
 *
 * Everything here is best-effort: if the browser cannot decode the file, the
 * original is uploaded untouched rather than failing the send.
 */

/** Longest edge of a compressed image. Comfortably above any bubble or lightbox. */
const MAX_EDGE = 2048;

/** Files below this are already small enough that re-encoding can only hurt. */
const COMPRESS_THRESHOLD_BYTES = 512 * 1024;

/** JPEG/WebP quality. 0.82 is the point where artefacts stop being visible. */
const QUALITY = 0.82;

/** Formats that must survive untouched: animation and transparency-critical. */
const PASSTHROUGH = new Set(['image/gif', 'image/svg+xml', 'image/avif']);

export interface Dimensions {
  width: number;
  height: number;
}

function scaledTo(width: number, height: number, maxEdge: number): Dimensions {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function decode(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await createImageBitmap(file);
  } catch {
    // Corrupt file, unsupported codec, or a HEIC that this browser cannot read.
    return null;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, QUALITY);
  });
}

/** True when the browser can encode WebP, which is ~30% smaller than JPEG here. */
function supportsWebp(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

export interface PreparedImage {
  file: File;
  dimensions: Dimensions | null;
  /** True when the returned file differs from the input. */
  compressed: boolean;
}

/**
 * Downscales and re-encodes an image if that would make it meaningfully smaller.
 * Returns the original file whenever compression is inapplicable or unhelpful.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/') || PASSTHROUGH.has(file.type)) {
    return { file, dimensions: null, compressed: false };
  }

  const bitmap = await decode(file);
  if (!bitmap) return { file, dimensions: null, compressed: false };

  const natural: Dimensions = { width: bitmap.width, height: bitmap.height };
  const target = scaledTo(natural.width, natural.height, MAX_EDGE);
  const sameSize = target.width === natural.width && target.height === natural.height;

  if (sameSize && file.size < COMPRESS_THRESHOLD_BYTES) {
    bitmap.close();
    return { file, dimensions: natural, compressed: false };
  }

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;

  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return { file, dimensions: natural, compressed: false };
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();

  const mimeType = supportsWebp() ? 'image/webp' : 'image/jpeg';
  const blob = await canvasToBlob(canvas, mimeType);

  // Re-encoding an already-optimised file can produce a *larger* one; in that
  // case the original wins.
  if (!blob || blob.size >= file.size) {
    return { file, dimensions: natural, compressed: false };
  }

  const extension = mimeType === 'image/webp' ? 'webp' : 'jpg';
  const baseName = file.name.replace(/\.[^./\\]+$/, '');
  const compressed = new File([blob], `${baseName}.${extension}`, {
    type: mimeType,
    lastModified: file.lastModified,
  });

  return { file: compressed, dimensions: target, compressed: true };
}

export interface VideoProbe {
  dimensions: Dimensions | null;
  /** Seconds. Null for a stream the browser reports as unbounded. */
  duration: number | null;
  /** A frame to use as the poster, or null when the codec cannot be decoded here. */
  poster: Blob | null;
}

/** Longest edge of a captured poster frame. Ample for a bubble or a lightbox. */
const POSTER_MAX_EDGE = 960;

/** How long to wait on a decoder before giving up and uploading without metadata. */
const PROBE_TIMEOUT_MS = 10_000;

/** Where to grab the poster: far enough in to miss a fade from black. */
const POSTER_POSITION_RATIO = 0.1;
const POSTER_MAX_OFFSET_SECONDS = 2;

function capturePoster(video: HTMLVideoElement): Promise<Blob | null> {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return Promise.resolve(null);

  const target = scaledTo(videoWidth, videoHeight, POSTER_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;

  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);

  try {
    context.drawImage(video, 0, 0, target.width, target.height);
  } catch {
    // A frame the browser refuses to hand over — DRM, or a decoder that
    // reported dimensions it cannot actually render.
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', QUALITY);
  });
}

/**
 * Reads what only a decoder knows about a video: its size, its running time and
 * a frame to show before it plays.
 *
 * The server has no ffmpeg, so without this a video arrives with no dimensions
 * (the bubble guesses 16:9), no duration and no poster. Entirely best-effort —
 * a container this browser cannot decode, such as MKV or AVI in Chrome, simply
 * yields nulls and the file uploads unchanged.
 */
export function probeVideo(file: File): Promise<VideoProbe> {
  const empty: VideoProbe = { dimensions: null, duration: null, poster: null };

  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(empty);
      return;
    }

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (probe: VideoProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(probe);
    };

    const timer = setTimeout(() => finish(empty), PROBE_TIMEOUT_MS);

    video.addEventListener('error', () => finish(empty), { once: true });

    video.addEventListener(
      'loadedmetadata',
      () => {
        const dimensions =
          video.videoWidth && video.videoHeight
            ? { width: video.videoWidth, height: video.videoHeight }
            : null;
        // A clip recorded in-browser reports Infinity until it is seeked.
        const duration =
          Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;

        let captured = false;
        const capture = (): void => {
          if (captured) return;
          captured = true;
          void capturePoster(video).then((poster) => finish({ dimensions, duration, poster }));
        };

        // Whichever arrives first: a seek lands on a representative frame, but
        // a source that cannot seek still has its first frame decoded.
        video.addEventListener('seeked', capture, { once: true });
        video.addEventListener('loadeddata', capture, { once: true });

        video.currentTime = Math.min(
          POSTER_MAX_OFFSET_SECONDS,
          (duration ?? 0) * POSTER_POSITION_RATIO,
        );
      },
      { once: true },
    );

    video.src = url;
  });
}
