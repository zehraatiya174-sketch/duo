import type { Server as SocketServer, Socket } from 'socket.io';

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@/types/socket';

export type DuoServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type DuoSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * The live server instance, published so HTTP route handlers running in the
 * same process can push realtime updates without owning a socket themselves.
 */
const globalForSocket = globalThis as unknown as { __duoSocketServer?: DuoServer };

export function setSocketServer(server: DuoServer): void {
  globalForSocket.__duoSocketServer = server;
}

export function getSocketServer(): DuoServer | null {
  return globalForSocket.__duoSocketServer ?? null;
}
