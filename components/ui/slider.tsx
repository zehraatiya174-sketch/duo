'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Used for the video scrubber and volume.
 *
 * One thumb is rendered per value so the same component covers both the single
 * seek handle and any future range. The touch target is padded well beyond the
 * visible thumb — scrubbing a video on a phone with a 12px target is miserable.
 */
export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(function Slider({ className, value, defaultValue, ...props }, ref) {
  const thumbs = value?.length ?? defaultValue?.length ?? 1;

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      className={cn(
        'relative flex w-full touch-none select-none items-center py-2',
        'data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-[var(--hairline-strong)]">
        <SliderPrimitive.Range className="absolute h-full bg-[var(--accent)]" />
      </SliderPrimitive.Track>

      {Array.from({ length: thumbs }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          className={cn(
            'block size-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10',
            'transition-transform duration-150 hover:scale-110 active:scale-95',
            'disabled:pointer-events-none',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
