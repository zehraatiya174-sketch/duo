'use client';

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { useSocket } from '@/components/providers/socket-provider';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import type { ChatSummaryDTO } from '@/types/models';

/** Receipts are batched over this window so a fast scroll sends one event. */
const FLUSH_MS = 400;

export interface ReadReceipts {
  /** Report that a message is on screen. Safe to call repeatedly. */
  observe: (messageId: string) => void;
  /** Mark the whole conversation read — used by the "jump to latest" control. */
  markAllRead: () => void;
}

/**
 * Reports which messages the local user has actually seen.
 *
 * Read state is driven by visibility rather than by opening the conversation:
 * marking everything read on mount would tell the other person their message
 * was read while the tab sat in the background.
 */
export function useReadReceipts(chatId: string | null, enabled: boolean): ReadReceipts {
  const { emit, status } = useSocket();
  const client = useQueryClient();
  const queued = React.useRef(new Set<string>());
  const reported = React.useRef(new Set<string>());
  const timer = React.useRef<number | null>(null);

  const statusRef = React.useRef(status);
  statusRef.current = status;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  const flush = React.useCallback((): void => {
    timer.current = null;
    if (!chatId || queued.current.size === 0) return;

    const messageIds = [...queued.current];
    queued.current.clear();
    for (const id of messageIds) reported.current.add(id);

    if (statusRef.current === 'connected') {
      emit('receipt:read', { chatId, messageIds });
      return;
    }

    // The HTTP route performs the same fan-out, so a receipt raised while the
    // socket is down is not lost — it just takes a round trip longer.
    void api
      .post<{ unreadCount: number }>('/api/chat/read', { body: { chatId, messageIds } })
      .then(({ unreadCount }) => {
        client.setQueryData<ChatSummaryDTO>(queryKeys.chat(), (summary) =>
          summary ? { ...summary, unreadCount } : summary,
        );
      })
      .catch(() => {
        // Allow a later pass to retry these ids.
        for (const id of messageIds) reported.current.delete(id);
      });
  }, [chatId, emit, client]);

  const observe = React.useCallback(
    (messageId: string): void => {
      if (!enabledRef.current || reported.current.has(messageId)) return;
      queued.current.add(messageId);
      if (timer.current === null) {
        timer.current = window.setTimeout(flush, FLUSH_MS);
      }
    },
    [flush],
  );

  const markAllRead = React.useCallback((): void => {
    if (!chatId) return;
    void api
      .post<{ unreadCount: number }>('/api/chat/read', { body: { chatId } })
      .then(({ unreadCount }) => {
        client.setQueryData<ChatSummaryDTO>(queryKeys.chat(), (summary) =>
          summary ? { ...summary, unreadCount } : summary,
        );
      });
  }, [chatId, client]);

  // Send whatever is queued before the tab goes away; `pagehide` fires in cases
  // where `beforeunload` does not, notably on mobile Safari.
  React.useEffect(() => {
    const onHide = (): void => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      flush();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [flush]);

  return { observe, markAllRead };
}
