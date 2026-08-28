// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { sensorPointFromTap, type TapGeometry } from '@/hooks/use-camera';

/**
 * Turning a tap on the preview into a point on the sensor.
 *
 * Tap-to-focus is only worth having if it focuses where the finger went, and
 * two transforms sit between the two: `object-cover` crops the frame to fill
 * the box, and the front camera is drawn mirrored. Both are easy to get subtly
 * wrong in a way that still looks plausible on screen, so the arithmetic is
 * pinned here rather than eyeballed on a phone.
 */

function tap(overrides: Partial<TapGeometry> = {}): TapGeometry {
  return {
    tapX: 0,
    tapY: 0,
    // A 400x400 preview showing a 1920x1080 frame: the classic case, where the
    // sides are cropped hard to fill a square box.
    boxWidth: 400,
    boxHeight: 400,
    videoWidth: 1920,
    videoHeight: 1080,
    mirrored: false,
    ...overrides,
  };
}

const near = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 4);

describe('mapping a tap to the sensor', () => {
  it('puts the centre of the preview at the centre of the sensor', () => {
    const point = sensorPointFromTap(tap({ tapX: 200, tapY: 200 }));
    near(point.x, 0.5);
    near(point.y, 0.5);
  });

  it('accounts for the sides object-cover crops away', () => {
    // The frame is scaled to 711x400 to cover a 400x400 box, so 155.5px is lost
    // from each side. The left edge of the box is therefore not x=0 on the
    // sensor - it is well inside it.
    const point = sensorPointFromTap(tap({ tapX: 0, tapY: 200 }));

    expect(point.x).toBeGreaterThan(0.15);
    expect(point.x).toBeLessThan(0.25);
    // Height fills exactly, so nothing is cropped vertically.
    near(point.y, 0.5);
  });

  it('crops the other axis when the box is wider than the frame', () => {
    // A 400x400 frame in a 400x200 box: the top and bottom are cut instead.
    const point = sensorPointFromTap(
      tap({ tapX: 200, tapY: 0, boxWidth: 400, boxHeight: 200, videoWidth: 400, videoHeight: 400 }),
    );

    near(point.x, 0.5);
    near(point.y, 0.25);
  });

  it('maps the full frame one-to-one when the aspect ratios already agree', () => {
    const square = { boxWidth: 300, boxHeight: 300, videoWidth: 600, videoHeight: 600 };

    near(sensorPointFromTap(tap({ ...square, tapX: 0, tapY: 0 })).x, 0);
    near(sensorPointFromTap(tap({ ...square, tapX: 300, tapY: 300 })).y, 1);
    near(sensorPointFromTap(tap({ ...square, tapX: 75, tapY: 150 })).x, 0.25);
  });

  it('flips the horizontal axis for the mirrored front camera', () => {
    const geometry = { boxWidth: 300, boxHeight: 300, videoWidth: 300, videoHeight: 300 };

    const normal = sensorPointFromTap(tap({ ...geometry, tapX: 75, tapY: 150 }));
    const mirrored = sensorPointFromTap(tap({ ...geometry, tapX: 75, tapY: 150, mirrored: true }));

    near(normal.x, 0.25);
    near(mirrored.x, 0.75);
    // Mirroring is horizontal only - a tap near the top is still near the top.
    near(mirrored.y, normal.y);
  });

  it('keeps every result inside the sensor, even for a tap past the edge', () => {
    // A tap can land marginally outside a rounded preview, and a point outside
    // [0,1] is rejected by the camera rather than clamped by it.
    for (const [tapX, tapY] of [
      [-40, -40],
      [900, 900],
      [-5, 402],
    ] as const) {
      const point = sensorPointFromTap(tap({ tapX, tapY }));
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to the centre before the first frame has arrived', () => {
    // videoWidth is 0 until metadata loads; dividing by it would give NaN and
    // the camera would reject the constraint.
    const point = sensorPointFromTap(tap({ tapX: 100, videoWidth: 0, videoHeight: 0 }));
    expect(point).toEqual({ x: 0.5, y: 0.5 });
  });
});
