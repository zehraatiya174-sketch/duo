'use client';

import * as React from 'react';

/**
 * In-app video recording, on top of a camera stream this hook does not own.
 *
 * `useCamera` opens and releases the hardware; this only wraps a `MediaRecorder`
 * around the stream it is handed. Keeping the two apart is what lets the camera
 * switch lenses, zoom and take stills without ever consulting the recorder.
 *
 * Everything stays in memory. The encoder writes into an array of chunks, those
 * become a `Blob`, and the `Blob` is uploaded — at no point is a file written to
 * the gallery, to Downloads, or to any OS-level temporary location.
 */

export type VideoRecorderState = 'idle' | 'recording' | 'error';

export interface RecordedVideo {
  blob: Blob;
  /** Seconds, measured from the timer: WebM from `MediaRecorder` often has no duration header. */
  duration: number;
  mimeType: string;
}

export interface VideoRecorder {
  state: VideoRecorderState;
  /** Seconds recorded so far, updated ~5× a second. */
  elapsed: number;
  /** Seconds left of the hard ceiling. Reaches 0 exactly as recording auto-stops. */
  remaining: number;
  error: string | null;
  /** Begins recording the given live stream. */
  start: (stream: MediaStream | null) => void;
  /** Ends recording; the clip arrives through `onComplete`. */
  stop: () => void;
  /** Ends recording and throws the footage away. */
  cancel: () => void;
}

/** Hard ceiling. At the bitrate cap below, a clip this long is ~90 MB. */
export const MAX_VIDEO_SECONDS = 180;

/** How often the timer ticks. Fine enough to look live, coarse enough to be free. */
const TICK_MS = 200;

/**
 * Bits spent per pixel per frame.
 *
 * The bitrate has to follow the resolution, not sit at a constant: the same
 * 2.5 Mbps that looks clean at 1080p is wasteful at 480p, and the same constant
 * applied to a 720p stream — which is what this used to do — spent 1080p bytes
 * on 720p pixels while never capturing 1080p at all.
 *
 * 0.08 is a middle setting for the codecs `MediaRecorder` offers. VP9 stays
 * clean below it and H.264 wants a little more, so it errs slightly generous
 * for the worst case rather than starving it.
 */
const BITS_PER_PIXEL = 0.08;

/** Enough that even a small frame is not mush. */
const MIN_BITS_PER_SECOND = 800_000;

/**
 * The ceiling exists for the uplink, not the encoder.
 *
 * 1080p30 would ask for ~5 Mbps by the formula above, and three minutes of that
 * is 112 MB to push through a home connection. 4 Mbps keeps a full-length 1080p
 * clip near 90 MB, which is inside the upload limit with room to spare and a
 * difference no one can see on a phone.
 */
const MAX_BITS_PER_SECOND = 4_000_000;

/**
 * Picks a bitrate from what the camera actually gave us.
 *
 * `getSettings` reports the negotiated mode, which is the only honest source —
 * the constraints were a preference and the camera may have answered with
 * something else entirely.
 */
export function bitrateFor(stream: MediaStream): number {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const width = settings?.width;
  const height = settings?.height;

  // A track that will not say how large it is gets the middle of the range
  // rather than either extreme.
  if (!width || !height) return 2_500_000;

  const fps = settings.frameRate && settings.frameRate > 0 ? settings.frameRate : 30;
  const raw = width * height * fps * BITS_PER_PIXEL;

  return Math.round(Math.min(MAX_BITS_PER_SECOND, Math.max(MIN_BITS_PER_SECOND, raw)));
}

/** Preference order; browsers disagree and `isTypeSupported` is the only oracle. */
const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=h264',
  'video/mp4',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return CANDIDATE_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function extensionForVideo(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

/**
 * @param onComplete Receives the finished clip. Also fires when the three-minute
 * ceiling stops the recording by itself, which is why this is a callback rather
 * than a promise returned from `stop`.
 */
export function useVideoRecorder({
  onComplete,
}: {
  onComplete: (clip: RecordedVideo) => void;
}): VideoRecorder {
  const [state, setState] = React.useState<VideoRecorderState>('idle');
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const timerRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef(0);
  const elapsedRef = React.useRef(0);
  const discardRef = React.useRef(false);

  // Held in a ref so starting a recording does not depend on the identity of a
  // callback the caller almost certainly re-creates every render.
  const completeRef = React.useRef(onComplete);
  completeRef.current = onComplete;

  const clearTimer = React.useCallback((): void => {
    if (timerRef.current === null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const finish = React.useCallback((): void => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  }, []);

  const start = React.useCallback(
    (stream: MediaStream | null): void => {
      if (!stream || recorderRef.current) return;

      if (typeof MediaRecorder === 'undefined') {
        setState('error');
        setError('This browser cannot record video.');
        return;
      }

      try {
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: bitrateFor(stream),
        });

        recorderRef.current = recorder;
        chunksRef.current = [];
        discardRef.current = false;
        startedAtRef.current = Date.now();
        elapsedRef.current = 0;
        setElapsed(0);
        setError(null);

        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        });

        recorder.addEventListener(
          'stop',
          () => {
            clearTimer();
            const chunks = chunksRef.current;
            const duration = elapsedRef.current;
            const discarded = discardRef.current;

            chunksRef.current = [];
            recorderRef.current = null;
            elapsedRef.current = 0;
            setElapsed(0);
            setState('idle');

            if (discarded) return;

            const type = recorder.mimeType || mimeType || 'video/webm';
            const blob = new Blob(chunks, { type });
            // A clip shorter than a blink is a mis-tap, not a recording.
            if (blob.size === 0 || duration < 0.4) return;

            completeRef.current({ blob, duration: Number(duration.toFixed(2)), mimeType: type });
          },
          { once: true },
        );

        // A timeslice keeps chunks arriving during the recording, so a crash
        // costs the last fragment rather than the whole clip.
        recorder.start(1000);
        setState('recording');

        // Read off the wall clock rather than counting ticks: a throttled or
        // drifting interval would otherwise let a clip run past the ceiling,
        // and the length reported here has to match the footage.
        timerRef.current = window.setInterval(() => {
          elapsedRef.current = Math.min(
            MAX_VIDEO_SECONDS,
            (Date.now() - startedAtRef.current) / 1000,
          );
          setElapsed(elapsedRef.current);
          if (elapsedRef.current >= MAX_VIDEO_SECONDS) finish();
        }, TICK_MS);
      } catch {
        recorderRef.current = null;
        setState('error');
        setError('Recording could not be started.');
      }
    },
    [clearTimer, finish],
  );

  const stop = React.useCallback((): void => {
    discardRef.current = false;
    finish();
  }, [finish]);

  const cancel = React.useCallback((): void => {
    discardRef.current = true;
    finish();
    clearTimer();
    chunksRef.current = [];
    elapsedRef.current = 0;
    setElapsed(0);
    setState('idle');
  }, [clearTimer, finish]);

  // A recorder must not outlive the component: an orphaned one would keep
  // buffering chunks of a stream nobody is watching.
  React.useEffect(
    () => () => {
      discardRef.current = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorderRef.current = null;
      chunksRef.current = [];
    },
    [],
  );

  return {
    state,
    elapsed,
    remaining: Math.max(0, MAX_VIDEO_SECONDS - elapsed),
    error,
    start,
    stop,
    cancel,
  };
}
