'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Decorative glyph rendered inside the field's leading edge. */
  leadingIcon?: React.ReactNode;
  /** Interactive affordance on the trailing edge — the password reveal toggle. */
  trailingSlot?: React.ReactNode;
  /**
   * Drives the error styling and `aria-invalid`. Kept separate from the native
   * attribute so callers pass a boolean rather than the string union.
   */
  invalid?: boolean;
}

/**
 * The single text field used across auth and search.
 *
 * The icons are positioned rather than laid out in a flex row so that
 * `react-hook-form`'s `register()` can spread directly onto the `<input>` — a
 * wrapper that swallowed the ref would break every uncontrolled form.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leadingIcon, trailingSlot, invalid, disabled, ...props },
  ref,
) {
  return (
    <div className="relative w-full">
      {leadingIcon ? (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-3 grid place-items-center',
            'text-[var(--text-muted)] [&_svg]:size-4',
          )}
        >
          {leadingIcon}
        </span>
      ) : null}

      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-10 w-full rounded-[var(--radius-md)] border bg-[var(--surface-sunken)]',
          'px-3 text-sm text-[var(--text-primary)]',
          'transition-[border-color,box-shadow] duration-150',
          'border-[var(--hairline-strong)] focus:border-[var(--accent)]',
          'disabled:cursor-not-allowed disabled:opacity-60',
          // The ring is drawn by :focus-visible globally; suppress the double ring.
          'focus:outline-none focus-visible:outline-none',
          'focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_35%,transparent)]',
          leadingIcon && 'pl-9',
          trailingSlot && 'pr-10',
          invalid &&
            'border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[color-mix(in_oklch,var(--color-danger)_35%,transparent)]',
          className,
        )}
        {...props}
      />

      {trailingSlot ? (
        <span className="absolute inset-y-0 right-1 grid place-items-center">{trailingSlot}</span>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grows with the content instead of scrolling internally. */
  autoResize?: boolean;
  /** Ceiling for `autoResize`, in lines. Past this the field scrolls. */
  maxRows?: number;
  invalid?: boolean;
}

/**
 * Multi-line input, used by the composer and by inline message editing.
 *
 * Auto-resize measures rather than counts: `scrollHeight` accounts for wrapped
 * lines, which a newline count does not, so a single long paragraph grows the
 * field exactly as much as it needs. The height is reset to `auto` first
 * because `scrollHeight` never shrinks below the current height — without that
 * reset the box would only ever grow, never contract when text is deleted.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoResize = false, maxRows = 8, invalid, onChange, ...props },
  ref,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Merges the forwarded ref with the local one the resize logic needs.
  const setRef = React.useCallback(
    (node: HTMLTextAreaElement | null): void => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const resize = React.useCallback((): void => {
    const node = innerRef.current;
    if (!node || !autoResize) return;

    node.style.height = 'auto';
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight) || 20;
    const max = lineHeight * maxRows;
    node.style.height = `${Math.min(node.scrollHeight, max)}px`;
    node.style.overflowY = node.scrollHeight > max ? 'auto' : 'hidden';
  }, [autoResize, maxRows]);

  // Also runs when the value changes from outside — clearing the composer after
  // a send has to collapse the box back to one line.
  React.useEffect(resize, [resize, props.value]);

  return (
    <textarea
      ref={setRef}
      rows={1}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        resize();
        onChange?.(event);
      }}
      className={cn(
        'w-full resize-none rounded-[var(--radius-md)] border bg-[var(--surface-sunken)]',
        'px-3 py-2 text-sm leading-6 text-[var(--text-primary)]',
        'border-[var(--hairline-strong)] transition-[border-color] duration-150',
        'focus:border-[var(--accent)] focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid && 'border-[var(--color-danger)] focus:border-[var(--color-danger)]',
        className,
      )}
      {...props}
    />
  );
});
