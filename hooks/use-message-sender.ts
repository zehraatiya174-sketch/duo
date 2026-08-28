'use client';

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { useSocket } from '@/components/providers/socket-provider';
import { api } from '@/lib/api/client';
import {
  updateAllMessageCaches,
  patchMessage,
  removeMessage,
  upsertMessage,
} from '@/lib/messages/cache';
import { buildOptimisticMessage, createClientId } from '@/lib/messages/optimistic';
import { dequeue, enqueue, markAttempt, readOutbox, type OutboxEntry } from '@/lib/messages/outbox';
import { queryKeys } from '@/lib/query-keys';
import type { AttachmentDTO, MessageDTO } from '@/types/models';
import type { SendMessagePayload } from '@/types/socket';

export interface ComposeInput {
  type: MessageDTO['type'];
  body?: string;
  codeLanguage?: string;
  replyTo?: MessageDTO | null;
  attachments?: AttachmentDTO[];
  location?: { lat: number; lng: number; label?: string };
  ephemeral?: SendMessagePayload['ephemeral'];
  mentions?: SendMessagePayload['mentions'];
}

export interface MessageSender {
  send: (input: ComposeInput) => Promise<void>;
  retry: (clientId: string) => Promise<void>;
  discard: (clientId: string) => void;
  /** Client ids still awaiting acknowledgement, for the composer's status line. */
  pending: string[];
}

/**
 * Owns the send path: optimistic insert, transport selection, and retry.
 *
 * Sends prefer the socket, because a message that goes out over the open
 * connection is delivered to the other person in the same round trip. The HTTP
 * route is the fallback for the seconds around a reconnect — it produces the
 * same broadcast server-side, so the two paths are interchangeable.
 *
 * Every send is idempotent on `clientId`, which is what makes retrying safe:
 * a send that actually succeeded but whose acknowledgement was lost resolves to
 * the original message rather than creating a duplicate.
 */
export function useMessageSender(chatId: string | null, selfId: string): MessageSender {
  const client = useQueryClient();
  const { status, request } = useSocket();
  const [pending, setPending] = React.useState<string[]>(() =>
    readOutbox().map((entry) => entry.payload.clientId),
  );

  const syncPending = React.useCallback((entries: OutboxEntry[]): void => {
    setPending(entries.map((entry) => entry.payload.clientId));
  }, []);

  const settle = React.useCallback(
    (message: MessageDTO): void => {
      syncPending(dequeue(message.clientId));
      updateAllMessageCaches(client, message.chatId, (data) => upsertMessage(data, message));
      void client.invalidateQueries({ queryKey: queryKeys.chat() });
    },
    [client, syncPending],
  );

  const fail = React.useCallback(
    (payload: SendMessagePayload, error: unknown): void => {
      const message = error instanceof Error ? error.message : 'Could not send';
      syncPending(markAttempt(payload.clientId, message));
      updateAllMessageCaches(client, payload.chatId, (data) =>
        patchMessage(data, payload.clientId, { status: 'FAILED' }),
      );
    },
    [client, syncPending],
  );

  /**
   * One delivery attempt. Resolves whether or not it succeeded.
   *
   * The socket is tried first when it is up, because a message sent over the
   * open connection reaches the other person in the same round trip. HTTP is
   * not only the path for when the socket is *known* to be down — it also
   * catches the case where the socket believes it is connected but the
   * acknowledgement never comes back. That happens for real: a large upload
   * saturates the uplink for a minute, the heartbeat cannot get through, and a
   * send issued in that window times out against a connection that is dead but
   * has not noticed yet. Without this fallback the message is marked failed
   * while a perfectly good HTTP route sits unused.
   *
   * Sending twice is safe — the server is idempotent on `clientId` — so a
   * socket send that actually landed but lost its acknowledgement resolves to
   * the original message rather than creating a second one.
   */
  const attempt = React.useCallback(
    async (payload: SendMessagePayload): Promise<void> => {
      try {
        if (status === 'connected') {
          try {
            settle(await request('message:send', payload));
            return;
          } catch {
            // Fall through to HTTP rather than reporting a failure the other
            // transport may well not have.
          }
        }
        settle(await api.post<MessageDTO>('/api/messages', { body: payload }));
      } catch (error) {
        fail(payload, error);
      }
    },
    [status, request, settle, fail],
  );

  const send = React.useCallback(
    async (input: ComposeInput): Promise<void> => {
      if (!chatId) return;

      const payload: SendMessagePayload = {
        clientId: createClientId(),
        chatId,
        type: input.type,
        ...(input.body ? { body: input.body } : {}),
        ...(input.codeLanguage ? { codeLanguage: input.codeLanguage } : {}),
        ...(input.replyTo ? { replyToId: input.replyTo.id } : {}),
        ...(input.attachments?.length
          ? { attachmentIds: input.attachments.map((attachment) => attachment.id) }
          : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.ephemeral ? { ephemeral: input.ephemeral } : {}),
        ...(input.mentions?.length ? { mentions: input.mentions } : {}),
      };

      const optimistic = buildOptimisticMessage(payload, {
        authorId: selfId,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.replyTo
          ? {
              replyTo: {
                id: input.replyTo.id,
                authorId: input.replyTo.authorId,
                authorName: '',
                type: input.replyTo.type,
                preview: input.replyTo.body ?? '',
                deleted: input.replyTo.deletedForAll,
              },
            }
          : {}),
      });

      // Queue before rendering: if the tab dies between the two, the message is
      // recoverable, whereas the reverse order would show a bubble that no
      // longer exists after a reload.
      syncPending(enqueue(payload));
      updateAllMessageCaches(client, chatId, (data) => upsertMessage(data, optimistic));

      await attempt(payload);
    },
    [chatId, selfId, client, syncPending, attempt],
  );

  const retry = React.useCallback(
    async (clientId: string): Promise<void> => {
      const entry = readOutbox().find((item) => item.payload.clientId === clientId);
      if (!entry) return;
      updateAllMessageCaches(client, entry.payload.chatId, (data) =>
        patchMessage(data, clientId, { status: 'PENDING' }),
      );
      await attempt(entry.payload);
    },
    [client, attempt],
  );

  const discard = React.useCallback(
    (clientId: string): void => {
      const entry = readOutbox().find((item) => item.payload.clientId === clientId);
      syncPending(dequeue(clientId));
      if (entry) {
        updateAllMessageCaches(client, entry.payload.chatId, (data) =>
          removeMessage(data, clientId),
        );
      }
    },
    [client, syncPending],
  );

  // Drain the queue whenever the connection comes back. Sends run in sequence so
  // messages arrive in the order they were written rather than in whatever order
  // the server happens to finish them.
  const attemptRef = React.useRef(attempt);
  attemptRef.current = attempt;

  React.useEffect(() => {
    if (status !== 'connected') return;

    let cancelled = false;
    const drain = async (): Promise<void> => {
      for (const entry of readOutbox()) {
        if (cancelled) return;
        await attemptRef.current(entry.payload);
      }
    };
    void drain();

    return () => {
      cancelled = true;
    };
  }, [status]);

  return { send, retry, discard, pending };
}
