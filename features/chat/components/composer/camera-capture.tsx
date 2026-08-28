'use client';

import { Camera, RefreshCw, Square, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useCamera } from '@/hooks/use-camera';
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

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="lg" className="overflow-hidden p-0" hideClose>
        <DialogTitle className="sr-only">Record a video</DialogTitle>

        <div className="relative aspect-[3/4] w-full bg-black sm:aspect-video">
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

          <Button
            variant="ghost"
            size="icon"
            onClick={close}
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
          {recording ? 'Tap to stop and send' : 'Tap to start recording'}
        </p>
      </DialogContent>
    </Dialog>
  );
}
