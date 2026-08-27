'use client';

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { useSocket, useSocketEvent } from '@/components/providers/socket-provider';
import {
  type MessagePages,
  patchMessage,
  removeMessage,
  updateAllMessageCaches,
  upsertMessage,
} from '@/lib/messages/cache';
import { queryKeys } from '@/lib/query-keys';
import type {
  ChatSummaryDTO,
  MessageDTO,
  NotificationDTO,
  PresenceState,
  PublicProfile,
} from '@/types/models';

export interface RealtimeState {
  /** True while the other participant is composing. */
  peerTyping: boolean;
  /** Ephemeral messages the peer opened during this session, newest first. */
  recentlyViewed: string[];
  /** Screenshot/focus-loss warnings raised for the messages we sent. */
  suspicions: Array<{ messageId: string; reason: string; at: string }>;
}

export interface RealtimeOptions {
  chatId: string | null;
  selfId: string;
  /** Called for every inbound message the local user did not write. */
  onIncomingMessage?: (message: MessageDTO) => void;
  onNotification?: (notification: NotificationDTO) => void;
}

/** How long a typing indicator survives without a refresh from the sender. */
const TYPING_TIMEOUT_MS = 6_000;

/**
 * Applies the realtime stream to the query cache.
 *
 * Every server event is folded into the cached pages rather than triggering a
 * refetch: a chat that refetched forty messages each time a reaction changed
 * would be both slow and visibly unstable under the reader's scroll position.
 */
export function useRealtime(options: RealtimeOptions): RealtimeState {
  const { chatId, selfId, onIncomingMessage, onNotification } = options;
  const client = useQueryClient();
  const { emit } = useSocket();

  const [peerTyping, setPeerTyping] = React.useState(false);
  const [recentlyViewed, setRecentlyViewed] = React.useState<string[]>([]);
  const [suspicions, setSuspicions] = React.useState<RealtimeState['suspicions']>([]);
  const typingTimer = React.useRef<number | null>(null);

  const incomingRef = React.useRef(onIncomingMessage);
  incomingRef.current = onIncomingMessage;
  const notificationRef = React.useRef(onNotification);
  notificationRef.current = onNotification;

  useSocketEvent('message:new', (message) => {
    updateAllMessageCaches(client, message.chatId, (data) => upsertMessage(data, message));

    if (message.authorId === selfId) return;

    // Acknowledging delivery from the client rather than at fan-out time keeps
    // the double tick honest: it means the message reached a device, not merely
    // that the server tried.
    emit('receipt:delivered', { chatId: message.chatId, messageIds: [message.id] });
    setPeerTyping(false);
    incomingRef.current?.(message);
  });

  useSocketEvent('message:updated', (message) => {
    updateAllMessageCaches(client, message.chatId, (data) => upsertMessage(data, message));
  });

  useSocketEvent('message:deleted', ({ messageId, chatId: eventChatId, scope }) => {
    updateAllMessageCaches(client, eventChatId, (data) =>
      scope === 'me'
        ? removeMessage(data, messageId)
        : patchMessage(data, messageId, {
            deletedForAll: true,
            body: null,
            attachments: [],
            reactions: [],
            linkPreviews: [],
            pinned: false,
          }),
    );
    void client.invalidateQueries({ queryKey: queryKeys.pinned(eventChatId) });
  });

  useSocketEvent('message:reaction', ({ messageId, chatId: eventChatId, reactions }) => {
    updateAllMessageCaches(client, eventChatId, (data) =>
      patchMessage(data, messageId, { reactions }),
    );
  });

  useSocketEvent('message:pinned', ({ messageId, chatId: eventChatId, pinned }) => {
    updateAllMessageCaches(client, eventChatId, (data) =>
      patchMessage(data, messageId, { pinned }),
    );
    void client.invalidateQueries({ queryKey: queryKeys.pinned(eventChatId) });
  });

  useSocketEvent('receipt:update', ({ chatId: eventChatId, messageIds, userId, kind, at }) => {
    // A receipt from ourselves is our own read state syncing across devices; it
    // says nothing about whether the other person has seen anything.
    if (userId === selfId) return;
    const ids = new Set(messageIds);

    updateAllMessageCaches(client, eventChatId, (data) => {
      if (!data) return data;
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => {
            if (!ids.has(item.id)) return item;
            if (kind === 'delivered') {
              // Never walk a receipt backwards: read implies delivered.
              if (item.status === 'READ') return { ...item, deliveredAt: item.deliveredAt ?? at };
              return { ...item, status: 'DELIVERED', deliveredAt: at };
            }
            return { ...item, status: 'READ', readAt: at, deliveredAt: item.deliveredAt ?? at };
          }),
        })),
      } satisfies MessagePages;
    });
  });

  useSocketEvent('typing:update', (state) => {
    if (state.userId === selfId || (chatId && state.chatId !== chatId)) return;

    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    setPeerTyping(state.typing);

    if (state.typing) {
      // A sender that disconnects mid-word never sends the "stopped" event, so
      // the indicator has to be able to expire on its own.
      typingTimer.current = window.setTimeout(() => setPeerTyping(false), TYPING_TIMEOUT_MS);
    }
  });

  useSocketEvent('presence:update', (state: PresenceState) => {
    client.setQueryData<PublicProfile[]>(queryKeys.participants(), (participants) =>
      participants?.map((participant) =>
        participant.userId === state.userId
          ? { ...participant, presence: state.presence, lastSeenAt: state.lastSeenAt }
          : participant,
      ),
    );
  });

  useSocketEvent('unread:update', ({ chatId: eventChatId, unreadCount }) => {
    client.setQueryData<ChatSummaryDTO>(queryKeys.chat(), (summary) =>
      summary && summary.id === eventChatId ? { ...summary, unreadCount } : summary,
    );
  });

  useSocketEvent(
    'ephemeral:viewed',
    ({ messageId, chatId: eventChatId, viewerId, viewCount, remainingViews }) => {
      updateAllMessageCaches(client, eventChatId, (data) =>
        patchMessage(data, messageId, (current) =>
          current.ephemeral
            ? {
                ...current,
                ephemeral: {
                  ...current.ephemeral,
                  viewCount,
                  // `remainingViews` is scoped to the viewer, so it only applies
                  // to our own copy when we are the one who opened it.
                  remainingViews:
                    viewerId === selfId ? remainingViews : current.ephemeral.remainingViews,
                },
              }
            : current,
        ),
      );
      if (viewerId !== selfId) {
        setRecentlyViewed((current) => [messageId, ...current.filter((id) => id !== messageId)]);
      }
    },
  );

  useSocketEvent('ephemeral:purged', ({ messageId, chatId: eventChatId }) => {
    updateAllMessageCaches(client, eventChatId, (data) =>
      patchMessage(data, messageId, (current) => ({
        ...current,
        body: null,
        attachments: [],
        linkPreviews: [],
        ephemeral: current.ephemeral
          ? { ...current.ephemeral, consumed: true, remainingViews: 0, unopened: false }
          : null,
      })),
    );
  });

  useSocketEvent('ephemeral:suspicion', ({ messageId, viewerId, reason, at }) => {
    if (viewerId === selfId) return;
    setSuspicions((current) => [{ messageId, reason, at }, ...current].slice(0, 20));
  });

  useSocketEvent('settings:updated', () => {
    // The server decides what is visible; the cache we are holding may describe
    // a history that has just been withdrawn, so it is dropped wholesale rather
    // than patched. Everything reloads from the server's current view.
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: ['shared-media'] });
    if (chatId) void client.invalidateQueries({ queryKey: queryKeys.pinned(chatId) });
    void client.invalidateQueries({ queryKey: queryKeys.chat() });
  });

  useSocketEvent('notification:new', (notification) => {
    client.setQueryData<NotificationDTO[]>(queryKeys.notifications(), (items) =>
      items ? [notification, ...items] : [notification],
    );
    notificationRef.current?.(notification);
  });

  React.useEffect(
    () => () => {
      if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  return { peerTyping, recentlyViewed, suspicions };
}
