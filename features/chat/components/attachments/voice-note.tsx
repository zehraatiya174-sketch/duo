'use client';

import { Pause, Play } from 'lucide-react';
import * as React from 'react';

import { cn, clamp, formatDuration } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';

/** Bars drawn when the recorder captured no peaks — a flat, honest placeholder. */
const FALLBACK_WAVEFORM = Array.from({ length: 40 }, () => 0.35);

/**
 * A voice note with a scrubbable waveform.
 *
 * The peaks come from the recorder, not from decoding the audio here: decoding
 * a clip client-side to draw it would download and process the whole file
 * before the first frame could be shown, on every render of the timeline.
 *
 * Progress is tracked in state rather than by animating a CSS variable because
 * each bar's colour depends on it — but `timeupdate` fires only ~4×/second, so
 * this is not a per-frame re-render.
 */
export function VoiceNote({
  attachment,
  mine,
}: {
  attachment: AttachmentDTO;
  mine: boolean;
}): React.JSX.Element {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);

  const peaks = attachment.waveform.length > 0 ? attachment.waveform : FALLBACK_WAVEFORM;
  const duration = attachment.duration ?? 0;

  const toggle = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const seekTo = (ratio: number): void => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = clamp(ratio, 0, 1) * audio.duration;
  };

  const progress = duration > 0 ? position / duration : 0;

  if (attachment.purged || !attachment.url) {
    return (
      <div className="rounded-[var(--radius-md)] bg-current/10 px-3 py-2 text-xs italic opacity-70">
        This voice note is no longer available
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-xl)] bg-current/10 px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play voice note'}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-current/20 transition-transform active:scale-95"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      {/*
        A slider rather than a row of buttons: this is one continuous value, and
        arrow keys should scrub it. The bars themselves are decorative.
      */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={formatDuration(position)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') seekTo(progress + 0.05);
          if (event.key === 'ArrowLeft') seekTo(progress - 0.05);
        }}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          seekTo((event.clientX - box.left) / box.width);
        }}
        className="flex h-8 min-w-32 flex-1 cursor-pointer items-center gap-[2px]"
      >
        {peaks.map((peak, index) => (
          <span
            key={index}
            className={cn(
              'w-[2px] flex-1 rounded-full transition-opacity',
              index / peaks.length <= progress ? 'opacity-100' : 'opacity-40',
              mine ? 'bg-white' : 'bg-[var(--accent)]',
            )}
            style={{ height: `${clamp(peak, 0.08, 1) * 100}%` }}
          />
        ))}
      </div>

      <span className="shrink-0 text-xs tabular-nums opacity-75">
        {formatDuration(playing || position > 0 ? position : duration)}
      </span>

      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        className="hidden"
      />
    </div>
  );
}
