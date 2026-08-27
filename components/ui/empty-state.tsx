import * as React from 'react';

import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  /** Decorative glyph. Sized by the component, so pass a bare lucide icon. */
  icon?: React.ReactNode;
  /** A single call to action, when there is an obvious next step. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * The "nothing here" state for panels and lists.
 *
 * Deliberately quiet: an empty audit log is the normal case for a two-person
 * deployment, so this should read as reassurance rather than as an error. The
 * title says what is absent and the description says why that is fine.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            'mb-1 grid size-10 place-items-center rounded-full',
            'bg-[var(--surface-sunken)] text-[var(--text-muted)] [&_svg]:size-5',
          )}
        >
          {icon}
        </span>
      ) : null}

      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>

      {description ? (
        <p className="max-w-sm text-sm text-[var(--text-muted)]">{description}</p>
      ) : null}

      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
