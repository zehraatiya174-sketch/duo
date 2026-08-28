'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  cn(
    'relative inline-flex shrink-0 select-none items-center justify-center gap-2',
    'whitespace-nowrap font-medium',
    // Transform-only hover/press so a busy list of buttons never triggers layout.
    'transition-[background-color,border-color,color,opacity,transform] duration-150',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90',
        secondary: cn(
          'bg-[var(--surface)] text-[var(--text-primary)]',
          'border border-[var(--hairline-strong)] hover:bg-[var(--surface-sunken)]',
        ),
        ghost: 'text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)]',
        /** Filled but unobtrusive — an active toggle in the call controls. */
        subtle: 'bg-[var(--surface-sunken)] text-[var(--text-primary)] hover:bg-[var(--hairline)]',
        danger: 'bg-[var(--color-danger)] text-white hover:opacity-90',
        /** Alias of `danger`; both spellings appear at call sites. */
        destructive: 'bg-[var(--color-danger)] text-white hover:opacity-90',
        link: 'text-[var(--accent)] underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-7 gap-1.5 rounded-[var(--radius-xs)] px-2.5 text-xs',
        sm: 'h-9 rounded-[var(--radius-md)] px-3 text-sm',
        md: 'h-10 rounded-[var(--radius-md)] px-4 text-sm',
        lg: 'h-11 rounded-[var(--radius-lg)] px-5 text-base',
        icon: 'size-9 rounded-[var(--radius-md)] p-0',
        'icon-sm': 'size-7 rounded-[var(--radius-xs)] p-0 [&_svg:not([class*=size-])]:size-3.5',
        // Circular and large: the call controls are hit with a thumb, often in
        // motion, so they get a target well above the 44px minimum.
        'icon-lg': 'size-12 rounded-full p-0 [&_svg:not([class*=size-])]:size-5',
      },
      /** Fills the inline axis — used for the primary action in auth forms. */
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Renders the child element instead of a `<button>`, keeping the styles. */
  asChild?: boolean;
  /**
   * Swaps the label for a spinner and disables the button. The label is kept
   * mounted but hidden so the width does not collapse mid-submit.
   */
  loading?: boolean;
  /**
   * Glyph before the label. A prop rather than a child so the icon is not
   * duplicated behind the spinner while `loading`, and so it cannot be
   * accidentally placed after the text.
   */
  leadingIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    asChild = false,
    loading = false,
    leadingIcon,
    disabled,
    children,
    ...props
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size, block }), className);

  /**
   * `asChild` hands the styling to the caller's own element — a `Link`, an
   * `<a>` — so the child must reach `Slot` untouched. Wrapping it, as the
   * button branch below does for the spinner, makes Slot receive that wrapper
   * instead and it throws: "Expected a single React element child".
   *
   * `loading` and `leadingIcon` are therefore not offered here. Neither is
   * meaningful on a link, which navigates rather than submits, and silently
   * dropping them is better than rendering a spinner that never resolves.
   */
  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled ?? loading}
      data-loading={loading ? '' : undefined}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-4" />
        </span>
      ) : null}
      <span className={cn('contents', loading && 'invisible')}>
        {leadingIcon}
        {children}
      </span>
    </button>
  );
});

export { buttonVariants };
