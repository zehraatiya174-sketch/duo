'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { fade, scaleIn } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';

import { MediaGuard } from './media-guard';

/**
 * Full-screen media viewer for an album.
 *
 * Rendered inline rather than through Radix's Dialog because it owns the whole
 * viewport and needs raw keyboard control — arrow keys page through the album,
 * which a dialog's focus trap would otherwise intercept. The focus trap is
 * hand-rolled below for the same reason.
 */
export function Lightbox({
  items,
  index,
  allowDownload,
  protectedMedia,
  onIndexChange,
  onClose,
}: {
  items: AttachmentDTO[];
  index: number;
  allowDownload: boolean;
  protectedMedia: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const current = items[index];

  const go = React.useCallback(
    (delta: number): void => {
      if (items.length === 0) return;
      // Wraps, so paging past either end returns to the other rather than
      // stopping dead with no feedback.
      onIndexChange((index + delta + items.length) % items.length);
    },
    [index, items.length, onIndexChange],
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
    };

    window.addEventListener('keydown', onKeyDown);

    // The timeline behind must not scroll while the viewer is open — on iOS a
    // scrolling body under a fixed overlay is what causes the rubber-band drift.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [go, onClose]);

  if (!current) return null;

  const isVideo = current.kind === 'VIDEO';

  return (
    <AnimatePresence>
      <motion.div
        key="lightbox"
        variants={fade}
        initial="hidden"
        animate="visible"
        exit="exit"
        role="dialog"
        aria-modal="true"
        aria-label={current.fileName}
        className="fixed inset-0 z-[80] flex flex-col bg-black/92 backdrop-blur-sm"
      >
        <header className="flex items-center justify-between gap-3 p-3 text-white">
          <span className="min-w-0 truncate text-sm">
            {current.fileName}
            {items.length > 1 ? (
              <span className="ml-2 opacity-60">
                {index + 1} / {items.length}
              </span>
            ) : null}
          </span>

          <span className="flex items-center gap-1">
            {allowDownload && !current.purged && current.downloadUrl ? (
              <Button variant="ghost" size="icon" asChild aria-label="Download">
                <a href={current.downloadUrl} download={current.fileName}>
                  <Download />
                </a>
              </Button>
            ) : null}

            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" autoFocus>
              <X />
            </Button>
          </span>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center p-2 sm:p-6">
          {items.length > 1 ? (
            <Button
              variant="ghost"
              size="icon-lg"
              onClick={() => go(-1)}
              aria-label="Previous"
              className="absolute left-2 z-10 text-white"
            >
              <ChevronLeft />
            </Button>
          ) : null}

          <MediaGuard
            enabled={protectedMedia}
            className="flex max-h-full max-w-full items-center justify-center"
          >
            <motion.div key={current.id} variants={scaleIn} initial="hidden" animate="visible">
              {isVideo ? (
                <video
                  src={current.url ?? undefined}
                  poster={current.thumbnailUrl ?? undefined}
                  controls
                  autoPlay
                  playsInline
                  controlsList={allowDownload ? undefined : 'nodownload'}
                  className="max-h-[80dvh] max-w-full rounded-[var(--radius-md)]"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={current.url ?? undefined}
                  alt={current.fileName}
                  className={cn('max-h-[80dvh] max-w-full object-contain')}
                />
              )}
            </motion.div>
          </MediaGuard>

          {items.length > 1 ? (
            <Button
              variant="ghost"
              size="icon-lg"
              onClick={() => go(1)}
              aria-label="Next"
              className="absolute right-2 z-10 text-white"
            >
              <ChevronRight />
            </Button>
          ) : null}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
