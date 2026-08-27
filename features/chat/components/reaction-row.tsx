'use client';

import * as React from 'react';

import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PublicProfile, ReactionGroup } from '@/types/models';

/**
 * The emoji chips under a message.
 *
 * Each chip is a toggle rather than a display: tapping one you are already part
 * of removes your reaction, which is what makes the count act like a vote.
 * `aria-pressed` carries that state — without it a screen reader hears a button
 * and a number and cannot tell whether the user is in the group.
 */
export function ReactionRow({
  reactions,
  participants,
  mine,
  onToggle,
}: {
  reactions: ReactionGroup[];
  participants: PublicProfile[];
  /** Aligns the row with the bubble it belongs to. */
  mine: boolean;
  onToggle: (emoji: string) => void;
}): React.JSX.Element | null {
  if (reactions.length === 0) return null;

  const nameOf = (userId: string): string =>
    participants.find((profile) => profile.userId === userId)?.displayName ?? 'Someone';

  return (
    <div className={cn('mt-1 flex flex-wrap gap-1', mine ? 'justify-end' : 'justify-start')}>
      {reactions.map((group) => (
        <Hint key={group.emoji} label={group.userIds.map(nameOf).join(', ')}>
          <button
            type="button"
            onClick={() => onToggle(group.emoji)}
            aria-pressed={group.reacted}
            aria-label={`${group.emoji} — ${group.count} ${group.count === 1 ? 'reaction' : 'reactions'}`}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
              'transition-transform duration-150 active:scale-95',
              group.reacted
                ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
                : 'border-[var(--hairline)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--hairline-strong)]',
            )}
          >
            <span aria-hidden>{group.emoji}</span>
            <span className="tabular-nums">{group.count}</span>
          </button>
        </Hint>
      ))}
    </div>
  );
}
