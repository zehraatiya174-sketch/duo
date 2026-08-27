'use client';

import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as React from 'react';

import { clamp, cn } from '@/lib/utils';

/**
 * Determinate progress, used by the upload tray.
 *
 * The indicator is moved with `translateX` rather than by animating `width`:
 * an upload reports progress many times a second, and animating a layout
 * property would force a reflow on every one of those updates.
 */
export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(function Progress({ className, value, ...props }, ref) {
  const percent = clamp(value ?? 0, 0, 100);

  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={percent}
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="size-full flex-1 bg-[var(--accent)] transition-transform duration-150 ease-out"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});
