'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatFull, formatSeen } from '@/utils/datetime';

/**
 * Delivery state, told once.
 *
 * There are no per-message ticks. A tick beside every bubble repeats the same
 * fact all the way down a conversation, and between two people the only
 * question worth answering is whether the *last* thing you said has been read.
 * So a single line sits under the newest outgoing message and says when — and
 * says nothing at all until the other person has actually opened it.
 */
export interface MessageSeenLabelProps {
  /** ISO timestamp of the counterpart's read receipt, or null while unread. */
  readAt: string | null;
  className?: string;
}

export function MessageSeenLabel({
  readAt,
  className,
}: MessageSeenLabelProps): React.JSX.Element | null {
  // Re-render on a timer so "just now" ages into "1m ago" on its own; nothing
  // else would push a new render once the receipt has already arrived.
  const [, tick] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    if (!readAt) return;
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [readAt]);

  if (!readAt) return null;

  return (
    <span
      className={cn(
        'px-1 text-[0.6875rem] tabular-nums text-[var(--text-muted)] select-none',
        className,
      )}
      title={`Seen ${formatFull(readAt)}`}
      aria-label={`Seen ${formatSeen(readAt)}`}
    >
      Seen {formatSeen(readAt)}
    </span>
  );
}
