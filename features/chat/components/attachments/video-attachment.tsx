'use client';

import {
  Download,
  Gauge,
  Maximize2,
  Pause,
  PictureInPicture2,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';
import { formatDuration } from '@/utils/datetime';

import { MediaGuard } from './media-guard';

/** Offered in the theater player; 1× is always the starting point. */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Inline video with our own transport controls.
 *
 * The native control set is suppressed because it offers the same items
 * unconditionally — a download and, on disappearing media, picture-in-picture —
 * and both route around the ephemeral rules the rest of the surface enforces.
 * Saving is offered here instead, from a button that knows whether this
 * particular message permits it.
 *
 * The `theater` variant is what the lightbox mounts: the same element with more
 * transport — volume, playback speed, and picture-in-picture where it is
 * allowed — because a full-screen player offering less than the bubble did
 * would feel broken.
 */
export function VideoAttachment({
  attachment,
  protectedMedia,
  allowDownload = false,
  allowFullscreen = true,
  variant = 'inline',
  autoPlay = false,
  onReady,
  onFailed,
  onRequestFullscreen,
  className,
}: {
  attachment: AttachmentDTO;
  protectedMedia: boolean;
  /** Off by default: a disappearing clip must not be savable by accident. */
  allowDownload?: boolean;
  allowFullscreen?: boolean;
  /** `theater` adds volume, playback speed and picture-in-picture. */
  variant?: 'inline' | 'theater';
  autoPlay?: boolean;
  /** Fires once the first frame is decoded — the video is genuinely on screen. */
  onReady?: () => void;
  /** Fires when the source cannot be loaded at all. */
  onFailed?: () => void;
  /** Overrides the fullscreen button, so a viewer can expand its own container. */
  onRequestFullscreen?: () => void;
  className?: string;
}): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [volume, setVolume] = React.useState(1);
  const [speed, setSpeed] = React.useState(1);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState(attachment.duration ?? 0);

  const theater = variant === 'theater';
  // Picture-in-picture pops the video out of the page, where none of the
  // disappearing rules can reach it. It is offered only on ordinary media.
  const allowPip = theater && !protectedMedia;

  const ratio =
    attachment.width && attachment.height ? attachment.width / attachment.height : 16 / 9;

  const toggle = React.useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }, []);

  const seek = React.useCallback((value: number): void => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = (value / 100) * video.duration;
    setPosition(value);
  }, []);

  const requestFullscreen = React.useCallback((): void => {
    if (onRequestFullscreen) {
      onRequestFullscreen();
      return;
    }
    void videoRef.current?.requestFullscreen?.().catch(() => undefined);
  }, [onRequestFullscreen]);

  const togglePip = React.useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined);
      return;
    }
    void video.requestPictureInPicture?.().catch(() => undefined);
  }, []);

  const changeVolume = React.useCallback((next: number): void => {
    setVolume(next);
    const video = videoRef.current;
    if (!video) return;
    video.volume = next;
    video.muted = next === 0;
    setMuted(video.muted);
  }, []);

  const changeSpeed = React.useCallback((next: number): void => {
    setSpeed(next);
    const video = videoRef.current;
    if (video) video.playbackRate = next;
  }, []);

  if (attachment.purged || !attachment.url) {
    return (
      <div
        className={cn(
          'flex aspect-video w-full items-center justify-center rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] text-xs text-[var(--text-muted)]',
          className,
        )}
      >
        {attachment.purged ? 'This video has been destroyed' : 'Video unavailable'}
      </div>
    );
  }

  return (
    <MediaGuard
      enabled={protectedMedia}
      className={cn(
        'group relative overflow-hidden rounded-[var(--radius-lg)] bg-black',
        className,
      )}
    >
      <video
        ref={videoRef}
        src={attachment.url}
        poster={attachment.thumbnailUrl ?? undefined}
        preload="metadata"
        playsInline
        autoPlay={autoPlay}
        disablePictureInPicture={!allowPip}
        controlsList="nodownload noplaybackrate"
        style={{ aspectRatio: `${ratio}` }}
        className="w-full"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => {
          // A clip recorded in-app has no duration header, so an infinite value
          // here is normal; the length the sender measured is used instead.
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onLoadedData={() => onReady?.()}
        onError={() => onFailed?.()}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          if (Number.isFinite(video.duration) && video.duration > 0) {
            setPosition((video.currentTime / video.duration) * 100);
          }
        }}
        onClick={toggle}
        onDoubleClick={theater ? requestFullscreen : undefined}
      />

      <div
        data-video-controls
        className={cn(
          'absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-2 pt-6 pb-2',
          'opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100',
          playing ? '' : 'opacity-100',
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="text-white hover:bg-white/15"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>

        <Slider
          value={[position]}
          max={100}
          step={0.1}
          aria-label="Seek"
          onValueChange={(values) => seek(values[0] ?? 0)}
          className="flex-1"
        />

        <span className="min-w-[3.5rem] text-right font-mono text-[0.6875rem] text-white/80 tabular-nums">
          {formatDuration((position / 100) * duration)}
        </span>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            video.muted = !video.muted;
            setMuted(video.muted);
          }}
          aria-label={muted ? 'Unmute' : 'Mute'}
          className="text-white hover:bg-white/15"
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </Button>

        {theater ? (
          <>
            <Slider
              value={[muted ? 0 : volume]}
              max={1}
              step={0.05}
              aria-label="Volume"
              onValueChange={(values) => changeVolume(values[0] ?? 0)}
              className="hidden w-20 sm:flex"
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Playback speed"
                  className="text-white hover:bg-white/15"
                >
                  <Gauge className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[6rem]">
                {SPEEDS.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onSelect={() => changeSpeed(option)}
                    className={cn(option === speed && 'text-[var(--accent)]')}
                  >
                    {option}×
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {allowPip ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={togglePip}
                aria-label="Picture in picture"
                className="text-white hover:bg-white/15"
              >
                <PictureInPicture2 className="size-4" />
              </Button>
            ) : null}
          </>
        ) : null}

        {allowDownload && attachment.downloadUrl ? (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label="Download"
            className="text-white hover:bg-white/15"
          >
            {/* The signed path is minted per viewer, so this link is the
                viewer's own and expires with their session. */}
            <a href={attachment.downloadUrl} download={attachment.fileName}>
              <Download className="size-4" />
            </a>
          </Button>
        ) : null}

        {allowFullscreen ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={requestFullscreen}
            aria-label="Full screen"
            className="text-white hover:bg-white/15"
          >
            <Maximize2 className="size-4" />
          </Button>
        ) : null}
      </div>
    </MediaGuard>
  );
}
