'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, FileText, RotateCcw, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { scaleIn } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { UploadDraft } from '@/hooks/use-uploader';
import { formatBytes } from '@/utils/datetime';

/**
 * The strip of pending attachments above the composer.
 *
 * Uploads run while the caption is being typed, so this shows progress for
 * files the message does not yet reference. A failed upload stays put with a
 * retry rather than disappearing — the file is still on the sender's disk, and
 * silently dropping it would be worse than asking.
 */
export function AttachmentTray({
  drafts,
  onRetry,
  onRemove,
  className,
}: {
  drafts: UploadDraft[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  className?: string;
}): React.JSX.Element | null {
  if (drafts.length === 0) return null;

  return (
    <div
      className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}
      role="list"
      aria-label="Attachments to send"
    >
      <AnimatePresence initial={false}>
        {drafts.map((draft) => {
          const isImage = draft.file.type.startsWith('image/');
          const isVideo = draft.file.type.startsWith('video/');

          return (
            <motion.div
              key={draft.id}
              role="listitem"
              layout
              variants={scaleIn}
              initial="hidden"
              animate="visible"
              exit="exit"
              className={cn(
                'group/draft relative overflow-hidden rounded-[var(--radius-md)] border',
                'border-[var(--border)] bg-[var(--surface)]',
                draft.status === 'error' && 'border-[var(--color-danger)]',
                isImage || isVideo ? 'size-20' : 'flex w-56 items-center gap-2 p-2',
              )}
            >
              {draft.previewUrl && isImage ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL
                <img
                  src={draft.previewUrl}
                  alt={draft.file.name}
                  className="size-full object-cover"
                />
              ) : draft.previewUrl && isVideo ? (
                <video
                  src={draft.previewUrl}
                  muted
                  playsInline
                  className="size-full object-cover"
                />
              ) : (
                <>
                  <FileText className="size-8 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-[var(--text-primary)]">
                      {draft.file.name}
                    </span>
                    <span className="block text-[0.6875rem] text-[var(--text-muted)]">
                      {formatBytes(draft.file.size)}
                    </span>
                  </span>
                </>
              )}

              {draft.status === 'preparing' ? (
                <span className="absolute inset-0 grid place-items-center bg-black/45">
                  <Spinner className="size-5 text-white" />
                </span>
              ) : null}

              {draft.status === 'uploading' ? (
                <span className="absolute inset-x-0 bottom-0 bg-black/45 p-1">
                  <Progress
                    value={draft.progress}
                    aria-label={`Uploading ${draft.file.name}`}
                    className="h-1"
                  />
                </span>
              ) : null}

              {draft.status === 'error' ? (
                <span
                  className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-black/70 px-1 text-center"
                  // The reason is what makes the difference between trying again
                  // and choosing a smaller file; the badge alone says neither.
                  title={draft.error ?? undefined}
                >
                  <AlertCircle className="size-4 text-[var(--color-danger)]" aria-hidden />
                  {draft.error ? (
                    <span className="line-clamp-2 text-[0.625rem] leading-tight text-white/80">
                      {draft.error}
                    </span>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onRetry(draft.id)}
                    className="text-white"
                  >
                    <RotateCcw className="size-3" />
                    Retry
                  </Button>
                </span>
              ) : null}

              <button
                type="button"
                onClick={() => onRemove(draft.id)}
                aria-label={`Remove ${draft.file.name}`}
                className={cn(
                  'absolute top-1 right-1 grid size-5 place-items-center rounded-full',
                  'bg-black/60 text-white opacity-0 transition-opacity',
                  'group-hover/draft:opacity-100 focus-visible:opacity-100 focus-visible:outline-none',
                  'focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                )}
              >
                <X className="size-3" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
