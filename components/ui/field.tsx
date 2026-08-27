'use client';

import * as React from 'react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface FieldRenderArgs {
  /** Generated id to put on the control; the label's `htmlFor` matches it. */
  id: string;
  /**
   * Ids of the hint and error nodes, or `undefined` when there are none. Spread
   * straight onto the control's `aria-describedby`.
   */
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  label: React.ReactNode;
  /** Persistent helper text. Hidden from the accessible name once an error shows. */
  hint?: React.ReactNode;
  error?: string | undefined;
  className?: string;
  children: (args: FieldRenderArgs) => React.ReactNode;
}

/**
 * Label, control and validation message as one unit.
 *
 * The control is supplied through a render prop rather than as a child so the
 * generated id and `aria-describedby` reach it directly. Cloning a child to
 * inject those props would break the moment a caller wrapped its input, and
 * `react-hook-form` needs to spread `register()` onto the real element.
 *
 * The error slot reserves no space when empty — a form that grows as it fails
 * pushes the submit button out from under the pointer.
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: FieldProps): React.JSX.Element {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = Boolean(error);

  // An error supersedes the hint: announcing both makes the correction harder
  // to hear than the rule it broke.
  const describedBy = invalid ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>

      {children({ id, describedBy, invalid })}

      {invalid ? (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
