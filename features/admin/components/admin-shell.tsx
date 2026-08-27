'use client';

import { motion } from 'framer-motion';
import * as React from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { fadeUp, staggerItem } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * Shared furniture for the admin console.
 *
 * The console is a read-mostly operations screen, so the primitives here are
 * about legibility at a glance: a stat, a panel, and a status dot that means the
 * same thing everywhere it appears.
 */

export type StatusTone = 'positive' | 'warning' | 'danger' | 'neutral';

const TONE_DOT: Record<StatusTone, string> = {
  positive: 'bg-[var(--color-positive)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
  neutral: 'bg-[var(--color-ink-400)]',
};

const TONE_TEXT: Record<StatusTone, string> = {
  positive: 'text-[var(--color-positive)]',
  warning: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]',
  neutral: 'text-[var(--text-muted)]',
};

export function StatusDot({
  tone,
  label,
  pulse = false,
}: {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
}): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs font-medium', TONE_TEXT[tone])}>
      <span className={cn('relative size-2 rounded-full', TONE_DOT[tone])}>
        {pulse ? (
          <span
            className={cn('absolute inset-0 rounded-full motion-safe:animate-ping', TONE_DOT[tone])}
            aria-hidden
          />
        ) : null}
      </span>
      {label}
    </span>
  );
}

export function AdminPanel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <motion.section
      variants={fadeUp}
      className={cn(
        'glass overflow-hidden rounded-[var(--radius-lg)] border border-[var(--hairline)]',
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </motion.section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  tone?: StatusTone;
}): React.JSX.Element {
  return (
    <motion.div
      variants={staggerItem}
      className="glass rounded-[var(--radius-lg)] border border-[var(--hairline)] p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-[var(--text-muted)] uppercase">
          {label}
        </p>
        {icon ? <span className={cn('[&_svg]:size-4', TONE_TEXT[tone])}>{icon}</span> : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p> : null}
    </motion.div>
  );
}

/** Consistent loading treatment for any panel that lists rows. */
export function RowsSkeleton({ rows = 4 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="space-y-3 px-5 py-4">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12" />
      ))}
    </div>
  );
}

/** A failed admin fetch is worth showing verbatim: the reader is the operator. */
export function PanelError({ error }: { error: Error }): React.JSX.Element {
  return (
    <p role="alert" className="px-5 py-6 text-sm text-[var(--color-danger)]">
      {error.message}
    </p>
  );
}
