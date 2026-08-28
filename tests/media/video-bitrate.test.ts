// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MAX_VIDEO_SECONDS, bitrateFor } from '@/hooks/use-video-recorder';

/**
 * Choosing a recording bitrate.
 *
 * The camera is asked for the best mode a device can manage rather than a fixed
 * 720p, so the recorder can no longer assume a resolution. A constant bitrate
 * across every device is wrong in both directions at once: wasteful on a small
 * frame, starved on a large one.
 */

function stream(settings: MediaTrackSettings | null): MediaStream {
  return {
    getVideoTracks: () => (settings === null ? [] : [{ getSettings: () => settings }]),
  } as unknown as MediaStream;
}

const MB = 1024 * 1024;

/** Bytes a full-length clip would occupy at this bitrate. */
function fullLengthBytes(bitsPerSecond: number): number {
  return (bitsPerSecond * MAX_VIDEO_SECONDS) / 8;
}

describe('bitrate follows the captured resolution', () => {
  it('gives 1080p more than 720p, and 720p more than 480p', () => {
    const p1080 = bitrateFor(stream({ width: 1920, height: 1080, frameRate: 30 }));
    const p720 = bitrateFor(stream({ width: 1280, height: 720, frameRate: 30 }));
    const p480 = bitrateFor(stream({ width: 640, height: 480, frameRate: 30 }));

    expect(p1080).toBeGreaterThan(p720);
    expect(p720).toBeGreaterThan(p480);
  });

  it('caps 1080p so a full-length clip stays inside the upload limit', () => {
    const bits = bitrateFor(stream({ width: 1920, height: 1080, frameRate: 30 }));

    expect(bits).toBe(4_000_000);
    // Roughly 90 MB, well under the 200 MB ceiling even before audio.
    expect(fullLengthBytes(bits)).toBeLessThan(100 * MB);
  });

  it('does not starve a small frame', () => {
    const bits = bitrateFor(stream({ width: 320, height: 240, frameRate: 15 }));
    expect(bits).toBe(800_000);
  });

  it('scales with frame rate, not just size', () => {
    const at30 = bitrateFor(stream({ width: 1280, height: 720, frameRate: 30 }));
    const at15 = bitrateFor(stream({ width: 1280, height: 720, frameRate: 15 }));
    expect(at15).toBeLessThan(at30);
  });

  it('falls back to a middle value when the track will not report its size', () => {
    expect(bitrateFor(stream({ frameRate: 30 }))).toBe(2_500_000);
    expect(bitrateFor(stream(null))).toBe(2_500_000);
  });

  it('treats a zero frame rate as unknown rather than multiplying by nothing', () => {
    // A track reporting 0 fps would otherwise compute a bitrate of zero and
    // produce an unplayable clip.
    const bits = bitrateFor(stream({ width: 1280, height: 720, frameRate: 0 }));
    expect(bits).toBe(bitrateFor(stream({ width: 1280, height: 720, frameRate: 30 })));
  });

  it('never exceeds what the uploader will accept, at any resolution', () => {
    for (const [width, height] of [
      [640, 480],
      [1280, 720],
      [1920, 1080],
      [3840, 2160],
    ] as const) {
      const bits = bitrateFor(stream({ width, height, frameRate: 60 }));
      expect(fullLengthBytes(bits)).toBeLessThan(200 * MB);
    }
  });
});
