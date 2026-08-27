import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * An indeterminate progress indicator.
 *
 * Colour is inherited via `currentColor` so the same element works on an accent
 * button and on a muted panel without a variant prop. `aria-hidden` is
 * deliberate: a spinner is decorative, and the surrounding control already
 * announces its busy state through `aria-busy`.
 */
export function Spinner({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('size-4 animate-spin text-current', className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
