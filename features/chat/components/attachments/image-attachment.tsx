'use client';

import { EyeOff, ImageOff } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';

import { MediaGuard } from './media-guard';

/**
 * A photo, GIF or sticker in the timeline.
 *
 * A plain `<img>` rather than `next/image`: these are private, signed,
 * short-lived URLs served by this app's own route. Next's optimiser would proxy
 * and cache them on disk, which is precisely the wrong behaviour for media that
 * is supposed to expire — and the signed path changes on every fetch, so the
 * cache would never hit anyway.
 *
 * The intrinsic size is set from the stored dimensions so the timeline does not
 * reflow when the bytes land; without it, loading a screenful of photos jumps
 * the scroll position on every one.
 */
export function ImageAttachment({
  attachment,
  protectedMedia,
  blurred = false,
  onOpen,
  className,
}: {
  attachment: AttachmentDTO;
  protectedMedia: boolean;
  /** Covers the image until tapped — the NSFW preference. */
  blurred?: boolean;
  onOpen?: () => void;
  className?: string;
}): React.JSX.Element {
  const [failed, setFailed] = React.useState(false);
  const [revealed, setRevealed] = React.useState(!blurred);

  if (attachment.purged || !attachment.url || failed) {
    return (
      <div
        className={cn(
          'flex aspect-square w-full items-center justify-center gap-2',
          'rounded-[var(--radius-md)] bg-current/10 text-xs opacity-70',
          className,
        )}
      >
        <ImageOff className="size-4" aria-hidden />
        {attachment.purged ? 'No longer available' : 'Could not load'}
      </div>
    );
  }

  const interactive = Boolean(onOpen) && revealed;

  return (
    <MediaGuard enabled={protectedMedia} className={cn('relative overflow-hidden', className)}>
      <button
        type="button"
        disabled={!interactive && revealed}
        onClick={() => (revealed ? onOpen?.() : setRevealed(true))}
        aria-label={revealed ? `Open ${attachment.fileName}` : 'Show hidden media'}
        className="block w-full"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.thumbnailUrl ?? attachment.url}
          alt={attachment.fileName}
          width={attachment.width ?? undefined}
          height={attachment.height ?? undefined}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={cn(
            'w-full object-cover transition-[filter,transform] duration-200',
            attachment.kind === 'STICKER' ? 'bg-transparent' : 'aspect-square',
            !revealed && 'scale-105 blur-xl',
            interactive && 'hover:scale-[1.02]',
          )}
          // A tiny inline placeholder, so the frame is never empty.
          style={
            attachment.blurDataUrl
              ? { backgroundImage: `url(${attachment.blurDataUrl})`, backgroundSize: 'cover' }
              : undefined
          }
        />

        {!revealed ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white">
            <EyeOff className="size-5" aria-hidden />
            <span className="text-xs font-medium">Tap to show</span>
          </span>
        ) : null}
      </button>
    </MediaGuard>
  );
}
