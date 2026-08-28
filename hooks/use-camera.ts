'use client';

import * as React from 'react';

export type CameraFacing = 'user' | 'environment';
export type CameraState = 'idle' | 'starting' | 'ready' | 'denied' | 'unavailable';

/**
 * Torch and focus are in the Image Capture draft, not the DOM lib TypeScript
 * ships, so they have to be declared here. Declaring them does not make them
 * exist: everything below asks `getCapabilities()` first, because on a laptop
 * webcam or on iOS Safari none of it is there.
 */
interface AdvancedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
  focusDistance?: { min: number; max: number; step: number };
  pointsOfInterest?: unknown;
}

interface AdvancedConstraints {
  torch?: boolean;
  focusMode?: string;
  focusDistance?: number;
  pointsOfInterest?: { x: number; y: number }[];
}

export interface Camera {
  stream: MediaStream | null;
  state: CameraState;
  error: string | null;
  facing: CameraFacing;
  /** True when the device reports more than one camera. */
  canSwitch: boolean;
  /** True when this camera has a lamp. Front cameras almost never do. */
  canTorch: boolean;
  /** Whether the lamp is currently lit. */
  torch: boolean;
  /** Turns the lamp on or off. Silently does nothing when unsupported. */
  toggleTorch: () => Promise<void>;
  /** True when the camera exposes any focus control at all. */
  canFocus: boolean;
  /**
   * True when focus is being driven manually — that is, after a tap. Cleared by
   * `resetFocus`, which hands control back to the camera.
   */
  focusLocked: boolean;
  /**
   * Focuses on a point, given in normalised coordinates from the top-left of
   * the *displayed* frame. Resolves false when the camera would not take it.
   */
  focusAt: (x: number, y: number) => Promise<boolean>;
  /** Returns to continuous autofocus. */
  resetFocus: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
  flip: () => void;
  /** Grabs the current frame as a JPEG. Null before the stream is ready. */
  capture: (video: HTMLVideoElement | null) => Promise<File | null>;
}

/**
 * What to ask the camera for.
 *
 * `ideal` rather than `exact` throughout: it is a preference, not a
 * requirement, so a camera that cannot manage 1080p returns the closest mode it
 * has instead of failing to open at all. That is what makes one request work
 * across a laptop webcam, a flagship phone and an old tablet — asking for a
 * fixed 720p, as this used to, held the good cameras down to the worst one's
 * ceiling.
 *
 * Dimensions are deliberately expressed landscape. Phone sensors are natively
 * landscape and report themselves that way even when the phone is upright;
 * asking for a portrait frame makes the browser crop or letterbox one out of a
 * landscape capture, losing real pixels. Orientation is a display concern, and
 * the preview and player both already handle it.
 */
function preferredVideoConstraints(): MediaTrackConstraints {
  // Someone on a metered connection has said, at the OS level, that they would
  // rather not spend the data — and a 1080p clip is roughly twice the bytes.
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;

  if (connection?.saveData) {
    return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  }

  return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
}

export interface TapGeometry {
  /** Where the tap landed, relative to the preview's top-left, in CSS pixels. */
  tapX: number;
  tapY: number;
  /** The preview element's size. */
  boxWidth: number;
  boxHeight: number;
  /** The frame's intrinsic size, which rarely matches the box. */
  videoWidth: number;
  videoHeight: number;
  /** Front cameras are drawn mirrored, so screen-left is sensor-right. */
  mirrored: boolean;
}

/**
 * Translates a tap on the preview into a point on the sensor.
 *
 * Two transforms sit between the two, and skipping either aims the focus
 * somewhere the user did not point:
 *
 * - `object-cover` scales the frame to *fill* the box and crops the overflow,
 *   so the visible area is a window onto a larger image. A tap in the middle of
 *   the box is the middle of the sensor, but a tap near an edge is nowhere near
 *   the sensor's edge.
 * - The front camera is drawn mirrored so it behaves like a mirror, which flips
 *   the horizontal axis but not the vertical one.
 *
 * Returns normalised coordinates in [0, 1], which is what `pointsOfInterest`
 * expects.
 */
export function sensorPointFromTap(geometry: TapGeometry): { x: number; y: number } {
  const { boxWidth, boxHeight, videoWidth, videoHeight } = geometry;

  // Nothing sensible to compute before the first frame has arrived.
  if (!videoWidth || !videoHeight || !boxWidth || !boxHeight) return { x: 0.5, y: 0.5 };

  const scale = Math.max(boxWidth / videoWidth, boxHeight / videoHeight);
  const shownWidth = videoWidth * scale;
  const shownHeight = videoHeight * scale;

  // How much of the frame is cropped off each side by `object-cover`.
  const cropX = (shownWidth - boxWidth) / 2;
  const cropY = (shownHeight - boxHeight) / 2;

  const clamp = (value: number): number => Math.min(1, Math.max(0, value));

  let x = clamp((geometry.tapX + cropX) / shownWidth);
  const y = clamp((geometry.tapY + cropY) / shownHeight);

  return { x: geometry.mirrored ? 1 - x : x, y };
}

/**
 * Owns the camera stream.
 *
 * Kept apart from `useVideoRecorder`, which records whatever stream it is
 * handed: acquiring a camera and encoding a clip are separate concerns with
 * separate failure modes, and photo capture needs the stream without any
 * recorder at all.
 *
 * The tracks are always stopped on unmount. A `MediaStream` left running holds
 * the camera hardware open and leaves the recording indicator lit long after
 * the sheet has closed, which reads — reasonably — as the app spying.
 */
export function useCamera(withAudio = true): Camera {
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [state, setState] = React.useState<CameraState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [facing, setFacing] = React.useState<CameraFacing>('user');
  const [canSwitch, setCanSwitch] = React.useState(false);
  const [canTorch, setCanTorch] = React.useState(false);
  const [torch, setTorch] = React.useState(false);
  const [focusModes, setFocusModes] = React.useState<string[]>([]);
  const [focusLocked, setFocusLocked] = React.useState(false);

  // The active stream is mirrored into a ref so cleanup can reach it without
  // making every effect depend on the stream and re-run when it changes.
  const streamRef = React.useRef<MediaStream | null>(null);

  /** The live video track, or null. Everything below is a no-op without one. */
  const videoTrack = React.useCallback((): MediaStreamTrack | null => {
    return streamRef.current?.getVideoTracks()[0] ?? null;
  }, []);

  const capabilities = React.useCallback((): AdvancedCapabilities | null => {
    const track = videoTrack();
    // Chrome on desktop has the method but reports nothing useful; Safari on
    // iOS does not have it at all.
    if (!track || typeof track.getCapabilities !== 'function') return null;
    return track.getCapabilities() as AdvancedCapabilities;
  }, [videoTrack]);

  /**
   * Applies a non-standard constraint.
   *
   * These go in `advanced`, which is the part of the spec a browser is allowed
   * to ignore rather than reject — so a failure here means "this camera will
   * not do that", never that something is broken. Reported as a boolean instead
   * of thrown for exactly that reason.
   */
  const applyAdvanced = React.useCallback(
    async (constraint: AdvancedConstraints): Promise<boolean> => {
      const track = videoTrack();
      if (!track) return false;
      try {
        await track.applyConstraints({
          advanced: [constraint as MediaTrackConstraintSet],
        });
        return true;
      } catch {
        return false;
      }
    },
    [videoTrack],
  );

  const stop = React.useCallback((): void => {
    // Turning the lamp off before releasing the track: on some phones a torch
    // left on survives the track being stopped, and the user is left holding a
    // torch they cannot switch off from here.
    const track = streamRef.current?.getVideoTracks()[0];
    if (track) {
      void track
        .applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] })
        .catch(() => undefined);
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setState('idle');
    setTorch(false);
    setCanTorch(false);
    setFocusModes([]);
    setFocusLocked(false);
  }, []);

  const open = React.useCallback(
    async (mode: CameraFacing): Promise<void> => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setState('unavailable');
        setError('This browser cannot reach a camera');
        return;
      }

      setState('starting');
      setError(null);

      // Release the previous stream first: on most phones the two cameras
      // cannot both be open, so flipping without stopping fails outright.
      streamRef.current?.getTracks().forEach((track) => track.stop());

      try {
        const next = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode, ...preferredVideoConstraints() },
          audio: withAudio,
        });

        streamRef.current = next;
        setStream(next);
        setFacing(mode);
        setState('ready');

        // Torch and focus belong to the camera that just opened, not to the
        // device, so they are re-read on every open — flipping to the front
        // camera usually loses the lamp.
        const track = next.getVideoTracks()[0];
        const caps =
          track && typeof track.getCapabilities === 'function'
            ? (track.getCapabilities() as AdvancedCapabilities)
            : null;

        setCanTorch(caps?.torch === true);
        setTorch(false);
        setFocusModes(caps?.focusMode ?? []);
        setFocusLocked(false);

        // Prefer continuous autofocus where the camera offers it. Some Android
        // cameras open in single-shot and then never refocus, which looks like
        // a broken preview rather than a setting.
        if (caps?.focusMode?.includes('continuous')) {
          await track
            ?.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
            })
            .catch(() => undefined);
        }

        // Only knowable after permission is granted — before that the device
        // list is deliberately empty.
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCanSwitch(devices.filter((device) => device.kind === 'videoinput').length > 1);
      } catch (cause) {
        streamRef.current = null;
        setStream(null);

        const denied =
          cause instanceof DOMException &&
          (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');

        setState(denied ? 'denied' : 'unavailable');
        setError(
          denied
            ? 'Camera access was blocked. Allow it in your browser settings to use this.'
            : 'No camera could be opened',
        );
      }
    },
    [withAudio],
  );

  /**
   * The lamp.
   *
   * Only ever a continuous torch, never a timed flash: `MediaRecorder` is
   * recording this same track, so a flash fired mid-clip would show up as a
   * blown-out frame in the video. Holding it on is also what a person actually
   * wants when filming in the dark.
   */
  const toggleTorch = React.useCallback(async (): Promise<void> => {
    if (!canTorch) return;
    const next = !torch;
    if (await applyAdvanced({ torch: next })) {
      setTorch(next);
    } else {
      // The camera accepted the capability but refused the constraint, which
      // happens while another app holds the lamp. Do not leave the button
      // showing a state the hardware is not in.
      setCanTorch(false);
      setTorch(false);
    }
  }, [applyAdvanced, canTorch, torch]);

  /**
   * Tap to focus.
   *
   * `pointsOfInterest` is the part that actually aims the lens, and it is the
   * least widely implemented, so `focusMode: 'manual'`/`'single-shot'` is set
   * alongside it: on a camera that ignores the point, switching out of
   * continuous still forces a fresh focus pass, which is most of the benefit.
   */
  const focusAt = React.useCallback(
    async (x: number, y: number): Promise<boolean> => {
      const caps = capabilities();
      const modes = caps?.focusMode ?? [];
      if (modes.length === 0) return false;

      // Guard the range: a tap can land marginally outside a rounded preview.
      const point = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      const mode = modes.includes('single-shot')
        ? 'single-shot'
        : modes.includes('manual')
          ? 'manual'
          : modes[0]!;

      const applied =
        (caps?.pointsOfInterest !== undefined &&
          (await applyAdvanced({ focusMode: mode, pointsOfInterest: [point] }))) ||
        (await applyAdvanced({ focusMode: mode }));

      if (applied) setFocusLocked(mode !== 'continuous');
      return applied;
    },
    [applyAdvanced, capabilities],
  );

  const resetFocus = React.useCallback(async (): Promise<void> => {
    const modes = capabilities()?.focusMode ?? [];
    if (!modes.includes('continuous')) return;
    if (await applyAdvanced({ focusMode: 'continuous' })) setFocusLocked(false);
  }, [applyAdvanced, capabilities]);

  const start = React.useCallback((): Promise<void> => open(facing), [open, facing]);
  const flip = React.useCallback((): void => {
    void open(facing === 'user' ? 'environment' : 'user');
  }, [open, facing]);

  /**
   * A still, taken by painting the current video frame to a canvas.
   *
   * The front camera is mirrored on screen so it behaves like a mirror, but the
   * captured frame must not be — a photo of text taken with the selfie camera
   * would otherwise come out backwards. Hence the explicit un-mirror below.
   */
  const capture = React.useCallback(
    async (video: HTMLVideoElement | null): Promise<File | null> => {
      if (!video || !video.videoWidth) return null;

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext('2d');
      if (!context) return null;

      if (facing === 'user') {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92),
      );
      if (!blob) return null;

      return new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
    },
    [facing],
  );

  React.useEffect(() => stop, [stop]);

  return {
    stream,
    state,
    error,
    facing,
    canSwitch,
    canTorch,
    torch,
    toggleTorch,
    canFocus: focusModes.length > 0,
    focusLocked,
    focusAt,
    resetFocus,
    start,
    stop,
    flip,
    capture,
  };
}
