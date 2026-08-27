'use client';

import { Camera, Circle, RefreshCw, Square, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useCamera } from '@/hooks/use-camera';
import { extensionForVideo, useVideoRecorder } from '@/hooks/use-video-recorder';
import { cn, formatDuration } from '@/lib/utils';

/**
 * The in-app camera.
 *
 * Photo on tap, video on hold — the gesture everyone already knows from every
 * other messenger, so neither mode needs a label. The clip is handed back as a
 * `File` and sent through exactly the same uploader as a picked file; the
 * camera has no privileged path.
 */
export function CameraCapture({
  open,
  onOpenChange,
  onCapture,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the still or the clip. The sheet closes itself afterwards. */
  onCapture: (file: File, extras?: { duration?: number }) => void;
}): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const camera = useCamera(true);
  const holdTimer = React.useRef<number | null>(null);

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

  // The stream is acquired when the sheet opens and released when it closes;
  // holding the camera open behind a closed dialog would leave the hardware
  // indicator lit.
  React.useEffect(() => {
    if (open) void camera.start();
    else camera.stop();
    // `camera` is recreated every render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (videoRef.current && camera.stream) {
      videoRef.current.srcObject = camera.stream;
    }
  }, [camera.stream]);

  const takePhoto = async (): Promise<void> => {
    const file = await camera.capture(videoRef.current);
    if (!file) return;
    onCapture(file);
    onOpenChange(false);
  };

  // Press and hold for video: the recording only starts after a short delay, so
  // an ordinary tap is unambiguously a photo.
  const onPressStart = (): void => {
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      recorder.start(camera.stream);
    }, 350);
  };

  const onPressEnd = (): void => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
      void takePhoto();
      return;
    }
    if (recorder.state === 'recording') recorder.stop();
  };

  const recording = recorder.state === 'recording';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="overflow-hidden p-0" hideClose>
        <DialogTitle className="sr-only">Camera</DialogTitle>

        <div className="relative aspect-[3/4] w-full bg-black sm:aspect-video">
          {camera.state === 'ready' ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={cn(
                'size-full object-cover',
                // Mirrored on screen only; the captured frame is un-mirrored.
                camera.facing === 'user' && 'scale-x-[-1]',
              )}
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
            onClick={() => onOpenChange(false)}
            aria-label="Close the camera"
            className="absolute top-2 right-2 text-white"
          >
            <X />
          </Button>
        </div>

        <div className="flex items-center justify-between gap-6 px-6 py-5">
          <div className="w-12">
            {camera.canSwitch && !recording ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={camera.flip}
                aria-label="Switch camera"
              >
                <RefreshCw />
              </Button>
            ) : null}
          </div>

          <button
            type="button"
            disabled={camera.state !== 'ready'}
            onPointerDown={onPressStart}
            onPointerUp={onPressEnd}
            onPointerLeave={onPressEnd}
            aria-label={recording ? 'Stop recording' : 'Take a photo, or hold to record'}
            className={cn(
              'grid size-16 place-items-center rounded-full border-4 transition-transform',
              'border-[var(--hairline-strong)] active:scale-95 disabled:opacity-40',
              recording && 'border-[var(--color-danger)]',
            )}
          >
            {recording ? (
              <Square className="size-6 fill-[var(--color-danger)] text-[var(--color-danger)]" />
            ) : (
              <Circle className="size-12 fill-[var(--text-primary)] text-[var(--text-primary)]" />
            )}
          </button>

          <div className="w-12" />
        </div>

        <p className="pb-4 text-center text-xs text-[var(--text-muted)]">
          {recording ? 'Release to send' : 'Tap for a photo · hold to record'}
        </p>
      </DialogContent>
    </Dialog>
  );
}
