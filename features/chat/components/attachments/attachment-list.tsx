'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';

import { FileAttachment } from './file-attachment';
import { ImageAttachment } from './image-attachment';
import { Lightbox } from './lightbox';
import { VideoAttachment } from './video-attachment';
import { VoiceNote } from './voice-note';

const VISUAL_KINDS = new Set<AttachmentDTO['kind']>(['IMAGE', 'GIF', 'VIDEO', 'STICKER']);

/** Grid shape by count, matching how messengers lay out an album. */
function gridClass(count: number): string {
  if (count === 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-2';
  if (count === 3) return 'grid-cols-2 [&>*:first-child]:row-span-2';
  return 'grid-cols-2';
}

/**
 * Renders a message's attachments.
 *
 * Visual media is grouped into one album grid so a four-photo message reads as
 * a single object; everything else stacks as cards. Stickers bypass both — they
 * are drawn bare, without a card or a background.
 */
export function AttachmentList({
  attachments,
  mine,
  allowDownload,
  protectedMedia,
  blurred,
  className,
}: {
  attachments: AttachmentDTO[];
  mine: boolean;
  allowDownload: boolean;
  protectedMedia: boolean;
  blurred?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  const visual = React.useMemo(
    () => attachments.filter((attachment) => VISUAL_KINDS.has(attachment.kind)),
    [attachments],
  );
  const others = React.useMemo(
    () => attachments.filter((attachment) => !VISUAL_KINDS.has(attachment.kind)),
    [attachments],
  );

  if (attachments.length === 0) return null;

  const sticker =
    attachments.length === 1 && attachments[0]?.kind === 'STICKER' ? attachments[0] : null;

  if (sticker) {
    return (
      <ImageAttachment
        attachment={sticker}
        protectedMedia={protectedMedia}
        className={cn('w-32', className)}
      />
    );
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      {visual.length > 0 ? (
        <div
          className={cn(
            'grid gap-1 overflow-hidden rounded-[var(--radius-lg)]',
            gridClass(visual.length),
          )}
        >
          {visual.slice(0, 4).map((attachment, index) => {
            const hidden = visual.length - 4;
            const isLast = index === 3 && hidden > 0;

            return (
              <div key={attachment.id} className="relative">
                {attachment.kind === 'VIDEO' ? (
                  <VideoAttachment
                    attachment={attachment}
                    // Video is never offered for download and always guarded,
                    // regardless of the message's ephemeral setting: clips
                    // recorded in this app are meant to live in the app, not in
                    // the viewer's downloads folder. `controlsList="nodownload"`
                    // covers the player's own menu; MediaGuard covers
                    // right-click and drag-to-save.
                    protectedMedia
                    allowDownload={false}
                    // A video plays where it sits, so expanding it opens the
                    // same viewer the album uses rather than the browser's.
                    onRequestFullscreen={() => setLightboxIndex(index)}
                  />
                ) : (
                  <ImageAttachment
                    attachment={attachment}
                    protectedMedia={protectedMedia}
                    {...(blurred !== undefined ? { blurred } : {})}
                    onOpen={() => setLightboxIndex(index)}
                  />
                )}

                {isLast ? (
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(index)}
                    aria-label={`Show ${hidden} more`}
                    className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-semibold text-white backdrop-blur-[2px]"
                  >
                    +{hidden}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {others.map((attachment) =>
        attachment.kind === 'VOICE_NOTE' ? (
          <VoiceNote key={attachment.id} attachment={attachment} mine={mine} />
        ) : (
          <FileAttachment
            key={attachment.id}
            attachment={attachment}
            allowDownload={allowDownload}
          />
        ),
      )}

      {lightboxIndex !== null ? (
        <Lightbox
          items={visual}
          index={lightboxIndex}
          allowDownload={allowDownload}
          protectedMedia={protectedMedia}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </div>
  );
}
