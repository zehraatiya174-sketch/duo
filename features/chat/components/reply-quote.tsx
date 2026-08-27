'use client';

import { CornerUpRight, Reply } from 'lucide-react';
import * as React from 'react';

import { cn, truncate } from '@/lib/utils';
import type { MessageReferenceDTO } from '@/types/models';

const TYPE_LABEL: Record<string, string> = {
  IMAGE: 'Photo',
  VIDEO: 'Video',
  AUDIO: 'Voice note',
  FILE: 'File',
  LOCATION: 'Location',
  CODE: 'Code',
};

/**
 * The quoted stub above a reply, and the attribution line above a forward.
 *
 * Rendered as a button only when it can actually go somewhere: a reply to a
 * deleted message has nothing to jump to, and offering a dead control is worse
 * than offering none.
 */
export function ReplyQuote({
  reference,
  variant = 'reply',
  onJump,
  className,
}: {
  reference: MessageReferenceDTO;
  variant?: 'reply' | 'forward';
  onJump?: (messageId: string) => void;
  className?: string;
}): React.JSX.Element {
  const isForward = variant === 'forward';
  const jumpable = Boolean(onJump) && !reference.deleted && !isForward;

  const preview = reference.deleted
    ? 'Message deleted'
    : reference.preview
      ? truncate(reference.preview, 90)
      : (TYPE_LABEL[reference.type] ?? 'Message');

  const Icon = isForward ? CornerUpRight : Reply;

  const content = (
    <>
      <span className="flex items-center gap-1 text-[0.6875rem] font-semibold opacity-90">
        <Icon className="size-3" aria-hidden />
        {isForward ? 'Forwarded from' : ''} {reference.authorName || 'Unknown'}
      </span>
      <span className={cn('block truncate text-xs', reference.deleted && 'italic opacity-60')}>
        {preview}
      </span>
    </>
  );

  const shell = cn(
    'block w-full rounded-[var(--radius-xs)] border-l-2 px-2 py-1 text-left',
    // Inherits the bubble's colour so the same component works on both the
    // accent-filled outgoing bubble and the neutral incoming one.
    'border-current bg-current/10',
    jumpable && 'transition-opacity hover:opacity-80',
    className,
  );

  if (!jumpable) {
    return <div className={shell}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onJump?.(reference.id)}
      className={shell}
      aria-label={`Jump to the message from ${reference.authorName}`}
    >
      {content}
    </button>
  );
}
