'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import type { Socket } from 'socket.io-client';

import { signOut } from '@/lib/auth/client';
import { createSocket, type DuoClientSocket } from '@/lib/socket/client';
import type { Ack, AckFn, ClientToServerEvents, ServerToClientEvents } from '@/types/socket';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/**
 * The client events that take an acknowledgement callback.
 *
 * Derived from the wire contract by arity rather than listed by hand, so adding
 * an event to `ClientToServerEvents` cannot leave this behind. A one-parameter
 * signature is fire-and-forget; anything wider ends in an ack.
 */
type AckEvent = {
  [E in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[E]>['length'] extends 1
    ? never
    : E;
}[keyof ClientToServerEvents];

type AckPayload<E extends AckEvent> = Parameters<ClientToServerEvents[E]>[0];
type AckResult<E extends AckEvent> =
  NonNullable<Parameters<ClientToServerEvents[E]>[1]> extends AckFn<infer R> ? R : never;

interface SocketContextValue {
  socket: DuoClientSocket | null;
  status: ConnectionStatus;
  /** True once the socket has connected at least one time. */
  ready: boolean;
  /** Round-trip time in milliseconds, or null before the first probe lands. */
  latencyMs: number | null;
  /**
   * ISO timestamp of the moment the connection was lost, cleared on reconnect.
   * Consumers use it as the `since` cursor for gap replay.
   */
  disconnectedAt: string | null;
  /** Emits and resolves with the server's acknowledgement, or rejects. */
  request: <E extends AckEvent>(event: E, payload: AckPayload<E>) => Promise<AckResult<E>>;
  /** Fire-and-forget emit. Dropped silently while the socket is down. */
  emit: <E extends keyof ClientToServerEvents>(
    event: E,
    ...args: Parameters<ClientToServerEvents[E]>
  ) => void;
}

const SocketContext = React.createContext<SocketContextValue | null>(null);

/** Acknowledgement timeout: long enough for a slow link, short enough to retry. */
const ACK_TIMEOUT_MS = 12_000;

/** How often round-trip latency is sampled while connected. */
const PING_INTERVAL_MS = 20_000;

export function SocketProvider({
  chatId,
  children,
}: {
  /** Joined on connect and re-joined after every reconnect. */
  chatId: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();

  const socketRef = React.useRef<DuoClientSocket | null>(null);
  const [status, setStatus] = React.useState<ConnectionStatus>('connecting');
  const [ready, setReady] = React.useState(false);
  const [latencyMs, setLatencyMs] = React.useState<number | null>(null);
  const [disconnectedAt, setDisconnectedAt] = React.useState<string | null>(null);

  // Held in a ref so a change of conversation does not tear down the connection.
  const chatIdRef = React.useRef(chatId);
  chatIdRef.current = chatId;

  // Created lazily during render rather than in an effect: children mount before
  // effects run, and a null socket would make them miss their subscriptions.
  if (socketRef.current === null && typeof window !== 'undefined') {
    socketRef.current = createSocket();
  }

  React.useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onConnect = (): void => {
      setStatus('connected');
      setReady(true);
      setDisconnectedAt(null);
      const id = chatIdRef.current;
      if (id) socket.emit('chat:join', { chatId: id }, () => undefined);
    };

    const onDisconnect = (reason: Socket.DisconnectReason): void => {
      setLatencyMs(null);
      setDisconnectedAt((current) => current ?? new Date().toISOString());
      // A server-initiated disconnect does not auto-reconnect, so it is a
      // terminal offline state rather than a transient one.
      setStatus(reason === 'io server disconnect' ? 'offline' : 'reconnecting');
    };

    const onConnectError = (): void => {
      setStatus((current) => (current === 'connecting' ? 'connecting' : 'reconnecting'));
    };

    const onReconnectAttempt = (): void => setStatus('reconnecting');

    const onRevoked = (payload: { reason: string }): void => {
      toast.error('Signed out', { description: payload.reason });
      socket.disconnect();
      void signOut().finally(() => {
        router.replace('/login');
        router.refresh();
      });
    };

    const onServerError = (payload: { code: string; message: string }): void => {
      toast.error(payload.message);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('session:revoked', onRevoked);
    socket.on('server:error', onServerError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);

    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('session:revoked', onRevoked);
      socket.off('server:error', onServerError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.disconnect();
    };
  }, [router]);

  // Re-join when the active conversation changes on an already-open socket.
  React.useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected || !chatId) return;
    socket.emit('chat:join', { chatId }, () => undefined);
  }, [chatId]);

  // The browser knows about network loss before the socket's own timeout fires;
  // reacting to it turns a ten-second stall into an immediate reconnect.
  React.useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onOnline = (): void => {
      if (!socket.connected) socket.connect();
    };
    const onOffline = (): void => {
      setStatus('reconnecting');
      setDisconnectedAt((current) => current ?? new Date().toISOString());
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Latency probe, also doubling as a liveness check for the indicator.
  React.useEffect(() => {
    const socket = socketRef.current;
    if (!socket || status !== 'connected') return;

    const probe = (): void => {
      const sentAt = Date.now();
      socket
        .timeout(ACK_TIMEOUT_MS)
        .emit(
          'presence:ping',
          sentAt,
          (error: Error | null, response?: Ack<{ sentAt: number; serverTime: number }>) => {
            if (error || response?.status !== 'ok') return;
            setLatencyMs(Date.now() - sentAt);
          },
        );
    };

    probe();
    const timer = window.setInterval(probe, PING_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status]);

  const request = React.useCallback(
    <E extends AckEvent>(event: E, payload: AckPayload<E>): Promise<AckResult<E>> => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        return Promise.reject(new Error('Not connected'));
      }

      return new Promise<AckResult<E>>((resolve, reject) => {
        // The generic signature is enforced at the call site; inside the body
        // the event name is opaque, so the emit itself has to be untyped.
        const emitter = socket.timeout(ACK_TIMEOUT_MS) as unknown as {
          emit: (
            name: string,
            data: unknown,
            ack: (error: Error | null, response?: Ack<AckResult<E>>) => void,
          ) => void;
        };

        emitter.emit(event, payload, (error, response) => {
          if (error) {
            reject(new Error('The server did not respond in time'));
            return;
          }
          if (!response || response.status !== 'ok' || response.data === undefined) {
            reject(new Error(response?.error?.message ?? 'The server rejected the request'));
            return;
          }
          resolve(response.data);
        });
      });
    },
    [],
  );

  const emit = React.useCallback(
    <E extends keyof ClientToServerEvents>(
      event: E,
      ...args: Parameters<ClientToServerEvents[E]>
    ): void => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      socket.emit(event, ...(args as never));
    },
    [],
  );

  const value = React.useMemo<SocketContextValue>(
    () => ({ socket: socketRef.current, status, ready, latencyMs, disconnectedAt, request, emit }),
    [status, ready, latencyMs, disconnectedAt, request, emit],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const context = React.useContext(SocketContext);
  if (!context) throw new Error('useSocket must be used inside a SocketProvider');
  return context;
}

/**
 * Subscribes to a server event for the lifetime of the component.
 *
 * The handler lives in a ref so callers can pass an inline closure without
 * resubscribing every render — re-subscribing on each keystroke would drop
 * events in the gap between `off` and `on`.
 */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
): void {
  const { socket } = useSocket();
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;

  React.useEffect(() => {
    if (!socket) return;

    const listener = (...args: unknown[]): void => {
      (handlerRef.current as (...received: unknown[]) => void)(...args);
    };

    // socket.io's `on` overload resolves the listener type from a *literal*
    // event name; with a generic `E` it collapses to `never`. The generic
    // parameters on this function are what enforce the pairing, so the
    // registration itself is done through a structurally minimal view.
    const target = socket as unknown as {
      on: (name: string, fn: (...args: unknown[]) => void) => void;
      off: (name: string, fn: (...args: unknown[]) => void) => void;
    };

    target.on(event, listener);
    return () => {
      target.off(event, listener);
    };
  }, [socket, event]);
}
