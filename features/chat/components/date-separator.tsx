import * as React from 'react';

import { formatDayLabel, formatFull } from '@/utils/datetime';

/**
 * The sticky "Today" / "Yesterday" / date marker between runs of messages.
 *
 * `<time>` carries the machine-readable value while the visible label stays
 * relative, so a screen reader and a hover tooltip both give the exact date
 * that "Today" alone would not.
 */
export function DateSeparator({ date }: { date: string | Date }): React.JSX.Element {
  const iso = typeof date === 'string' ? date : date.toISOString();

  return (
    <div className="sticky top-2 z-10 my-4 flex items-center justify-center">
      <time
        dateTime={iso}
        title={formatFull(date)}
        className="glass rounded-full px-3 py-1 text-[0.6875rem] font-medium tracking-wide text-[var(--text-muted)] uppercase"
      >
        {formatDayLabel(date)}
      </time>
    </div>
  );
}
