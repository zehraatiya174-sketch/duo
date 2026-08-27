'use client';

import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as React from 'react';

import { cn, hueFromString, initialsOf } from '@/lib/utils';

const SIZES = {
  xs: 'size-6 text-[0.625rem]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-12 text-base',
  xl: 'size-16 text-lg',
  '2xl': 'size-24 text-2xl',
} as const;

export type AvatarSize = keyof typeof SIZES;

export interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
  /** Drives both the initials and the fallback tint. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
}

/**
 * A person, as a circle.
 *
 * Radix handles the part that matters: the fallback is only shown once the
 * image has actually failed or is still loading, so a slow avatar does not
 * flash initials and then swap. The fallback tint is derived from the name, so
 * the same person is the same colour on every device without storing anything.
 */
export const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  AvatarProps
>(function Avatar({ className, name, src, size = 'md', ...props }, ref) {
  const hue = hueFromString(name);

  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex shrink-0 overflow-hidden rounded-full select-none',
        'ring-1 ring-[var(--hairline)]',
        SIZES[size],
        className,
      )}
      {...props}
    >
      {src ? (
        <AvatarPrimitive.Image
          src={src}
          alt={name}
          className="aspect-square size-full object-cover"
        />
      ) : null}

      <AvatarPrimitive.Fallback
        // No delay: the initials are the resting state when there is no src at
        // all, and a delay would leave an empty circle for that whole window.
        delayMs={src ? 400 : 0}
        className="flex size-full items-center justify-center font-semibold"
        style={{
          backgroundColor: `oklch(0.72 0.11 ${hue})`,
          color: 'oklch(0.22 0.05 ' + hue + ')',
        }}
      >
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
});
