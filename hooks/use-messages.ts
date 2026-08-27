'use client';

import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import * as React from 'react';

import { api } from '@/lib/api/client';
import type { MessagePages } from '@/lib/messages/cache';
import { queryKeys } from '@/lib/query-keys';
import type { MessageDTO, Page } from '@/types/models';

/** Matches the server's cap; asking for more is silently clamped anyway. */
const PAGE_SIZE = 40;

export interface MessagesResult {
  /** Oldest first — the order the timeline renders in. */
  messages: MessageDTO[];
  query: UseInfiniteQueryResult<MessagePages, Error>;
  loadOlder: () => void;
  hasOlder: boolean;
  loadingOlder: boolean;
}

/**
 * The conversation timeline.
 *
 * Paginates backwards: page 0 is the newest messages and each further page is
 * older, which is why `getNextPageParam` walks toward the past rather than the
 * future. The socket, not this query, is what delivers new messages — they are
 * folded into these same cached pages by `lib/messages/cache`, so the timeline
 * never refetches to show something that just arrived.
 *
 * The flattened array is reversed once here rather than in the component: the
 * cache stores newest-first because that is how the API returns it, and the
 * timeline reads oldest-first because that is how a conversation is read.
 */
export function useMessages(chatId: string | null): MessagesResult {
  const query = useInfiniteQuery<
    Page<MessageDTO>,
    Error,
    MessagePages,
    ReturnType<typeof queryKeys.messages>,
    string | null
  >({
    queryKey: queryKeys.messages(chatId ?? ''),
    enabled: Boolean(chatId),
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      api.get<Page<MessageDTO>>('/api/messages', {
        searchParams: {
          chatId: chatId ?? '',
          limit: PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    // Realtime keeps this authoritative, so a remount should not refetch what
    // the socket has already been maintaining.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const messages = React.useMemo(() => {
    const pages = query.data?.pages ?? [];
    // Pages arrive newest-first and each page is itself newest-first, so the
    // whole flattened list reverses in one step.
    return pages.flatMap((page) => page.items).reverse();
  }, [query.data]);

  const loadOlder = React.useCallback((): void => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return {
    messages,
    query,
    loadOlder,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
  };
}
