'use client';

import { MotionConfig } from 'framer-motion';
import { ThemeProvider } from 'next-themes';
import * as React from 'react';
import { Toaster } from 'sonner';

import { QueryProvider } from '@/components/providers/query-provider';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Everything the whole tree needs, mounted once.
 *
 * Ordering matters in one place only: `QueryProvider` wraps the rest because a
 * toast or a tooltip may be rendered from inside a query's error path.
 */
export function AppProviders({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <QueryProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        // The theme flips instantly instead of tweening every colour on the
        // page — a full-page transition on a chat looks like a rendering bug.
        disableTransitionOnChange
      >
        {/*
         * `reducedMotion="user"` makes every Framer animation in the app honour
         * the OS setting without a single component checking it. The CSS half of
         * the same promise lives in the reduced-motion block in globals.css.
         */}
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            {children}

            <Toaster
              position="top-center"
              // Inherits the app palette rather than sonner's own, so a toast
              // over the dark theme is not a white slab.
              toastOptions={{
                classNames: {
                  toast:
                    'bg-[var(--surface)] text-[var(--text-primary)] border border-[var(--hairline)] shadow-[var(--shadow-float)]',
                  description: 'text-[var(--text-muted)]',
                  actionButton: 'bg-[var(--accent)] text-[var(--accent-foreground)]',
                  error: 'text-[var(--color-danger)]',
                  success: 'text-[var(--color-positive)]',
                },
              }}
            />
          </TooltipProvider>
        </MotionConfig>
      </ThemeProvider>
    </QueryProvider>
  );
}
