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

/** Hard ceiling. A clip this long is already ~55 MB at the bitrate below. */
export const MAX_VIDEO_SECONDS = 180;

/** How often the timer ticks. Fine enough to look live, coarse enough to be free. */
const TICK_MS = 200;

/**
 * ~2.5 Mbps is the compression step of the pipeline: visually clean at 1080p
 * and small enough that the full three minutes stays well inside the upload
 * limit, without a re-encode the browser would have to do on the main thread.
 */
const VIDEO_BITS_PER_SECOND = 2_500_000;

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
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
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
