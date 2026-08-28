'use client';

import { Camera, RefreshCw, Square, X, Zap, ZapOff } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { sensorPointFromTap, useCamera } from '@/hooks/use-camera';
import { extensionForVideo, useVideoRecorder } from '@/hooks/use-video-recorder';
import { cn, formatDuration } from '@/lib/utils';

/**
 * The in-app video recorder.
 *
 * Tap to start, tap again to stop — not press-and-hold. Holding a button for a
 * minute is an unreasonable thing to ask of anyone, and on touch it competes
 * with the browser's own long-press gesture.
 *
 * Video only, by design. There is no photo path here: the paperclip already
 * sends images, and a single-purpose shutter cannot be mistimed into taking a
 * still when a clip was wanted.
 *
 * **The clip never touches the disk.** `MediaRecorder` accumulates chunks in
 * memory, they become a `Blob`, the `Blob` becomes a `File` handed straight to
 * the uploader, and the upload is an in-memory XHR body. Nothing calls
 * `download`, nothing writes to the filesystem, and the object URL used for the
 * composer preview is revoked when the draft is dropped. The recording exists
 * in this tab's memory and in the app's storage — nowhere else.
 */
export function CameraCapture({
  open,
  onOpenChange,
  onCapture,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the finished clip. The sheet closes itself afterwards. */
  onCapture: (file: File, extras?: { duration?: number }) => void;
}): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const camera = useCamera(true);

  const recorder = useVideoRecorder({
    onComplete: (clip) => {
      const file = new File(
        [clip.blob],
        `video-${Date.now()}.${extensionForVideo(clip.mimeType)}`,
        { type: clip.mimeType },
      );
      onCapture(file, { duration: clip.duration });
      onOpenChange(false);
    },
  });

  const recording = recorder.state === 'recording';

  // The stream is acquired when the sheet opens and released when it closes;
  // holding the camera open behind a closed dialog leaves the hardware
  // indicator lit, which reads — reasonably — as the app watching.
  React.useEffect(() => {
    if (open) void camera.start();
    else camera.stop();
    // `camera` is a fresh object each render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (videoRef.current && camera.stream) videoRef.current.srcObject = camera.stream;
  }, [camera.stream]);

  /** Abandoning mid-recording must not silently send the footage. */
  const close = (): void => {
    if (recording) recorder.cancel();
    onOpenChange(false);
  };

  const toggle = (): void => {
    if (recording) recorder.stop();
    else recorder.start(camera.stream);
  };

  /** Tap to focus. The mapping itself is `sensorPointFromTap`. */
  const onFocusTap = (event: React.MouseEvent<HTMLDivElement>): void => {
    const video = videoRef.current;
    if (!video?.videoWidth || !camera.canFocus) return;

    const box = video.getBoundingClientRect();
    const tapX = event.clientX - box.left;
    const tapY = event.clientY - box.top;

    const point = sensorPointFromTap({
      tapX,
      tapY,
      boxWidth: box.width,
      boxHeight: box.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      mirrored: camera.facing === 'user',
    });

    setFocusPoint({ left: tapX, top: tapY });
    void camera.focusAt(point.x, point.y);
  };

  // The ring is drawn where the finger landed, then fades. It is the only
  // feedback that a tap did anything at all — the focus change itself is often
  // too subtle to notice on a small preview.
  const [focusPoint, setFocusPoint] = React.useState<{ left: number; top: number } | null>(null);
  React.useEffect(() => {
    if (!focusPoint) return;
    const timer = window.setTimeout(() => setFocusPoint(null), 900);
    return () => window.clearTimeout(timer);
  }, [focusPoint]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="lg" className="overflow-hidden p-0" hideClose>
        <DialogTitle className="sr-only">Record a video</DialogTitle>

        <div
          className="relative aspect-[3/4] w-full bg-black sm:aspect-video"
          onClick={camera.state === 'ready' ? onFocusTap : undefined}
        >
          {camera.state === 'ready' ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              // Mirrored on screen so the front camera behaves like a mirror.
              className={cn('size-full object-cover', camera.facing === 'user' && 'scale-x-[-1]')}
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center text-white">
              {camera.state === 'starting' ? (
                <Spinner className="size-6" />
              ) : (
                <>
                  <Camera className="size-6 opacity-70" aria-hidden />
                  <p className="text-sm opacity-80">{camera.error ?? 'Camera unavailable'}</p>
                </>
              )}
            </div>
          )}

          {recording ? (
            <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
              <span className="size-2 animate-pulse rounded-full bg-[var(--color-danger)]" />
              {formatDuration(recorder.elapsed)}
              <span className="opacity-60">−{formatDuration(recorder.remaining)}</span>
            </div>
          ) : null}

          {focusPoint ? (
            <span
              aria-hidden
              className="pointer-events-none absolute size-16 -translate-x-1/2 -translate-y-1/2 animate-[ping_0.9s_ease-out_1] rounded-lg border-2 border-white/90"
              style={{ left: focusPoint.left, top: focusPoint.top }}
            />
          ) : null}

          {/* Only rendered where the hardware actually has a lamp, which in
              practice means a phone's rear camera. */}
          {camera.canTorch ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={(event) => {
                // The preview behind this is the focus target.
                event.stopPropagation();
                void camera.toggleTorch();
              }}
              aria-pressed={camera.torch}
              aria-label={camera.torch ? 'Turn the light off' : 'Turn the light on'}
              className={cn(
                'absolute top-2 left-2',
                camera.torch ? 'text-amber-300' : 'text-white',
              )}
            >
              {camera.torch ? <Zap className="fill-current" /> : <ZapOff />}
            </Button>
          ) : null}

          {camera.focusLocked ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void camera.resetFocus();
              }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white"
            >
              Focus locked · tap to reset
            </button>
          ) : null}

          <Button
            variant="ghost"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
            aria-label={recording ? 'Discard recording and close' : 'Close the camera'}
            className="absolute top-2 right-2 text-white"
          >
            <X />
          </Button>
        </div>

        <div className="flex items-center justify-between gap-6 px-6 py-5">
          <div className="w-12">
            {camera.canSwitch && !recording ? (
              <Button variant="ghost" size="icon" onClick={camera.flip} aria-label="Switch camera">
                <RefreshCw />
              </Button>
            ) : null}
          </div>

          <button
            type="button"
            disabled={camera.state !== 'ready'}
            onClick={toggle}
            aria-pressed={recording}
            aria-label={recording ? 'Stop recording' : 'Start recording'}
            className={cn(
              'grid size-16 place-items-center rounded-full border-4 transition-transform',
              'active:scale-95 disabled:opacity-40',
              recording ? 'border-[var(--color-danger)]' : 'border-[var(--hairline-strong)]',
            )}
          >
            {recording ? (
              // A square reads as "stop" the way a second red dot does not.
              <Square className="size-6 fill-[var(--color-danger)] text-[var(--color-danger)]" />
            ) : (
              <span className="size-11 rounded-full bg-[var(--color-danger)]" />
            )}
          </button>

          <div className="w-12" />
        </div>

        <p className="pb-4 text-center text-xs text-[var(--text-muted)]">
          {recording
            ? 'Tap to stop and send'
            : camera.canFocus
              ? 'Tap to start recording · tap the preview to focus'
              : 'Tap to start recording'}
        </p>
      </DialogContent>
    </Dialog>
  );
}
