import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A placeholder block shown while content loads.
 *
 * The pulse is opacity-only so a screenful of skeletons stays cheap, and the
 * element is hidden from assistive tech — a screen reader should hear the
 * region's own loading state, not a dozen anonymous boxes.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-[var(--radius-md)] bg-[var(--surface-sunken)]',
        className,
      )}
      {...props}
    />
  );
}
