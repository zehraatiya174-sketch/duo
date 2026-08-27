'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * `TooltipProvider` is mounted once in `AppProviders`, so individual tooltips
 * do not each create their own delay group — without a shared provider, moving
 * between two adjacent icon buttons re-waits the full open delay every time.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        data-slot="panel"
        className={cn(
          'z-50 max-w-64 rounded-[var(--radius-md)] px-2.5 py-1.5',
          'bg-[var(--text-primary)] text-xs font-medium text-[var(--canvas)]',
          'shadow-[var(--shadow-float)]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

export interface HintProps {
  label: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['side'];
  children: React.ReactNode;
}

/**
 * The common case: one control, one line of text.
 *
 * `asChild` on the trigger is what keeps the wrapped button the real focusable
 * element — nesting a `<button>` inside Radix's default trigger button would be
 * invalid markup and would break keyboard activation.
 *
 * Note this is a supplement, never the only label: every icon button still
 * carries its own `aria-label`, because a tooltip is not announced on touch.
 */
export function Hint({ label, side = 'top', children }: HintProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
