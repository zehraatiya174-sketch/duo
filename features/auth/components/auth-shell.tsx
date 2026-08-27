'use client';

import { motion } from 'framer-motion';
import * as React from 'react';

import { fadeUp, stagger, staggerItem } from '@/lib/motion';

interface AuthShellProps {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * The card every authentication screen sits in.
 *
 * Kept as a client component so the entry animation runs on navigation between
 * the auth routes rather than only on a cold load.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: AuthShellProps): React.JSX.Element {
  return (
    <motion.div
      variants={stagger(0.06)}
      initial="hidden"
      animate="visible"
      className="w-full max-w-md"
    >
      <motion.div variants={fadeUp} className="glass-strong rounded-[var(--radius-3xl)] p-7 sm:p-9">
        <motion.header variants={staggerItem} className="mb-7 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            {title}
          </h1>
          <p className="text-sm leading-relaxed text-pretty text-[var(--text-secondary)]">
            {description}
          </p>
        </motion.header>

        <motion.div variants={staggerItem}>{children}</motion.div>
      </motion.div>

      {footer ? (
        <motion.div
          variants={staggerItem}
          className="mt-5 text-center text-sm text-[var(--text-secondary)]"
        >
          {footer}
        </motion.div>
      ) : null}
    </motion.div>
  );
}

/** Inline banner for errors that belong to the form as a whole, not a field. */
export function AuthAlert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'positive' | 'neutral';
  children: React.ReactNode;
}): React.JSX.Element {
  const toneClass = {
    danger: 'bg-[oklch(0.63_0.22_25/0.12)] text-[var(--color-danger)]',
    positive: 'bg-[oklch(0.72_0.17_155/0.14)] text-[var(--color-positive)]',
    neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  }[tone];

  return (
    <motion.p
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="alert"
      className={`rounded-[var(--radius-md)] px-3.5 py-2.5 text-sm leading-relaxed ${toneClass}`}
    >
      {children}
    </motion.p>
  );
}
