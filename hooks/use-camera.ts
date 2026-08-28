'use client';

import * as React from 'react';

export type CameraFacing = 'user' | 'environment';
export type CameraState = 'idle' | 'starting' | 'ready' | 'denied' | 'unavailable';

export interface Camera {
  stream: MediaStream | null;
  state: CameraState;
  error: string | null;
  facing: CameraFacing;
  /** True when the device reports more than one camera. */
  canSwitch: boolean;
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

  // The active stream is mirrored into a ref so cleanup can reach it without
  // making every effect depend on the stream and re-run when it changes.
  const streamRef = React.useRef<MediaStream | null>(null);

  const stop = React.useCallback((): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setState('idle');
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

  return { stream, state, error, facing, canSwitch, start, stop, flip, capture };
}
