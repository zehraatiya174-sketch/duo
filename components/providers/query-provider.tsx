'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { VERIFICATION_PATH } from '@/lib/auth/verification.shared';
import { AppError } from '@/lib/errors';

/**
 * A ticket can expire while the tab is open. When that happens every request
 * starts failing identically, so the gate is reasserted from one place instead
 * of each caller having to handle it.
 */
function redirectIfUnverified(error: unknown): void {
  if (!(error instanceof AppError) || error.code !== 'VERIFICATION_REQUIRED') return;
  if (typeof window === 'undefined') return;
  if (window.location.pathname === VERIFICATION_PATH) return;

  const next = `${window.location.pathname}${window.location.search}`;
  // A hard navigation, not `router.push`: the server components above this
  // tree also need to be re-evaluated against the missing ticket.
  window.location.assign(`${VERIFICATION_PATH}?next=${encodeURIComponent(next)}`);
}

/**
 * Creates the query client.
 *
 * A factory rather than a module-level singleton: in the App Router the module
 * is evaluated on the server too, and a shared client there would leak one
 * request's cache into another's.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: redirectIfUnverified }),
    mutationCache: new MutationCache({ onError: redirectIfUnverified }),
    defaultOptions: {
      queries: {
        // Socket pushes are the primary freshness mechanism; polling on top of
        // that would be redundant traffic, so queries stay fresh for a while.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // 4xx means the request was wrong, not unlucky — retrying a 403
          // just burns rate-limit budget.
          if (error instanceof AppError && error.status < 500 && error.status !== 429) {
            return false;
          }
          return failureCount < 3;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [client] = React.useState(createQueryClient);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
