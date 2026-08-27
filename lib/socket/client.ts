import { io, type Socket } from 'socket.io-client';

import { clientEnv } from '@/lib/env.client';
import type { ClientToServerEvents, ServerToClientEvents } from '@/types/socket';

/** The wire contract, bound to the browser end of the connection. */
export type DuoClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Builds the singleton connection used by `SocketProvider`.
 *
 * `autoConnect` is off because the provider connects inside an effect: creating
 * the socket during render and connecting immediately would open a connection
 * during React's strict-mode double render and leave one of the pair orphaned.
 *
 * Authentication rides on the session cookie rather than a token in the
 * handshake — `withCredentials` is what makes the browser send it. A token in
 * `auth` would have to be refreshed by hand and would outlive a revoked
 * session; the cookie is checked against the database on every connect.
 */
export function createSocket(): DuoClientSocket {
  // Same-origin unless realtime is deployed separately, in which case the URL is
  // absolute and CORS on the server must name this origin.
  const url = clientEnv.NEXT_PUBLIC_SOCKET_URL;

  return io(url ?? '', {
    path: clientEnv.NEXT_PUBLIC_SOCKET_PATH,
    autoConnect: false,
    withCredentials: true,

    // Polling first, then upgrade. Starting at `websocket` fails outright behind
    // proxies that do not pass the upgrade header, and a chat that never
    // connects is worse than one that connects a beat slower.
    transports: ['polling', 'websocket'],

    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8_000,
    // Spreads the reconnect storm when the server restarts and both clients
    // return at once.
    randomizationFactor: 0.5,

    timeout: 15_000,
  });
}
