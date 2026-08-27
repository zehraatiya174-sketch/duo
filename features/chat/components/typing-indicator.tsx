import * as React from 'react';

import { Avatar } from '@/components/ui/avatar';
import type { PublicProfile } from '@/types/models';

/**
 * The three-dot bubble shown while the other person is composing.
 *
 * Announced politely rather than assertively: typing is ambient information,
 * and an assertive live region would interrupt a screen reader mid-message
 * every time the other person touched their keyboard.
 *
 * The dots animate with `opacity` only — no transform, no layout — because this
 * runs continuously for as long as someone is typing.
 */
export function TypingIndicator({
  profile,
}: {
  profile: PublicProfile | null;
}): React.JSX.Element {
  const name = profile?.displayName ?? 'They';

  return (
    <div className="flex items-end gap-2 px-4 py-1">
      <Avatar size="xs" name={name} src={profile?.avatarUrl ?? null} />

      <div
        role="status"
        aria-live="polite"
        aria-label={`${name} is typing`}
        className="flex items-center gap-1 rounded-[var(--radius-xl)] rounded-bl-[var(--radius-xs)] bg-[var(--surface)] px-3 py-2.5 shadow-[var(--shadow-lift)]"
      >
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-1.5 animate-pulse rounded-full bg-[var(--text-muted)]"
            style={{ animationDelay: `${index * 160}ms`, animationDuration: '1.1s' }}
          />
        ))}
      </div>
    </div>
  );
}
