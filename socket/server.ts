import type { Server as HttpServer } from 'node:http';

import { Server as SocketServer } from 'socket.io';

import { db } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { purgeExpiredMessages } from '@/services/ephemeral';
import { assertChatMember } from '@/services/messages';
import { flushPendingDeliveries } from '@/services/receipts';
import { pruneRateLimitBuckets } from '@/lib/rate-limit';
import { pruneExpiredSessions } from '@/services/devices';
import { pruneErrorLogs } from '@/services/diagnostics';
import { pruneOrphanAttachments } from '@/services/storage';
import { SOCKET_ROOMS } from '@/types/socket';

import { authenticateSocket, isSessionStillValid } from './auth';
import { type DuoServer, type DuoSocket, setSocketServer } from './context';
import {
  cancelPendingCallTeardown,
  endCallsForUser,
  registerCallHandlers,
} from './handlers/calls';
import { registerEphemeralHandlers } from './handlers/ephemeral';
import { registerMessageHandlers } from './handlers/messages';
import { ack } from './handlers/shared';
import {
  clearTypingForUser,
  publishPresence,
  trackConnection,
  untrackConnection,
} from './presence';

const log = createLogger('socket:server');

/** How often to re-validate live sockets against their session rows. */
const SESSION_AUDIT_INTERVAL_MS = 5 * 60_000;
/** How often to sweep expired ephemeral content. */
const PURGE_INTERVAL_MS = 30_000;
/** How often to run cheap housekeeping. */
const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

export interface SocketServerHandle {
  io: DuoServer;
  shutdown: () => Promise<void>;
}

export function createSocketServer(httpServer: HttpServer): SocketServerHandle {
  const env = serverEnv();
  const origins = env.SOCKET_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const io: DuoServer = new SocketServer(httpServer, {
    path: env.SOCKET_PATH,
    cors: {
      origin: origins,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // WebSocket first; polling stays available so the app still works behind
    // proxies that mangle upgrades.
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    /*
     * Deliberately generous. This app sends large uploads over the same uplink
     * the socket runs on, and a home connection pushing a 100 MB video queues
     * deeply enough that a heartbeat can take tens of seconds to come back. At
     * the old 25 s the connection was declared dead partway through every big
     * upload — exactly when the user is most active — and the reconnect landed
     * right as they pressed send. A truly dead connection is still noticed:
     * the client watches `navigator.onLine` and reacts long before this fires.
     */
    pingTimeout: 60_000,
    connectionStateRecovery: {
      // Lets a client that blipped offline resume its rooms and replay missed
      // packets without a full re-handshake.
      maxDisconnectionDuration: 2 * 60_000,
      skipMiddlewares: false,
    },
    maxHttpBufferSize: 1e6,
    serveClient: false,
  });

  // --- authentication middleware -------------------------------------------
  io.use((socket, next) => {
    void (async () => {
      const auth = await authenticateSocket(socket as DuoSocket);
      if (!auth) {
        next(new Error('UNAUTHORIZED'));
        return;
      }
      const typed = socket as DuoSocket;
      typed.data.auth = auth;
      typed.data.chats = new Set();
      typed.data.connectedAt = Date.now();
      next();
    })();
  });

  io.on('connection', (socket: DuoSocket) => {
    const { userId, sessionId, displayName } = socket.data.auth;

    void socket.join(SOCKET_ROOMS.user(userId));

    // A reconnect within the grace window keeps any in-flight call alive.
    cancelPendingCallTeardown(userId);

    const isFirstConnection = trackConnection(userId, socket.id);
    log.info('Socket connected', {
      userId,
      socketId: socket.id,
      firstConnection: isFirstConnection,
    });

    if (isFirstConnection) {
      void publishPresence(io, userId, 'ONLINE');
    }

    // --- room membership ---------------------------------------------------
    socket.on('chat:join', (payload, respond) => {
      void (async () => {
        try {
          const chatId = String(payload?.chatId ?? '');
          await assertChatMember(chatId, userId);
          await socket.join(SOCKET_ROOMS.chat(chatId));
          socket.data.chats.add(chatId);
          respond(ack.ok({ chatId }));

          // Connecting *is* delivery — flush everything queued for this user.
          const update = await flushPendingDeliveries(userId, chatId);
          if (update) {
            for (const authorId of update.notifyUserIds) {
              io.to(SOCKET_ROOMS.user(authorId)).emit('receipt:update', {
                chatId,
                messageIds: update.messageIds,
                userId,
                kind: 'delivered',
                at: update.at,
              });
            }
          }
        } catch (error) {
          respond(
            ack.fail('FORBIDDEN', error instanceof Error ? error.message : 'Unable to join chat'),
          );
        }
      })();
    });

    // --- latency probe -----------------------------------------------------
    socket.on('presence:ping', (sentAt, respond) => {
      respond(ack.ok({ sentAt, serverTime: Date.now() }));
    });

    socket.on('presence:set', (payload) => {
      const presence = payload?.presence;
      if (presence === 'ONLINE' || presence === 'AWAY' || presence === 'BUSY') {
        void publishPresence(io, userId, presence);
      }
    });

    registerMessageHandlers(io, socket);
    registerEphemeralHandlers(io, socket);
    registerCallHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      const wasLast = untrackConnection(userId, socket.id);
      clearTypingForUser(io, userId);
      log.info('Socket disconnected', { userId, socketId: socket.id, reason, wasLast });

      if (wasLast) {
        void publishPresence(io, userId, 'OFFLINE');
        endCallsForUser(io, userId);
      }
    });

    void db.device
      .updateMany({ where: { sessionId }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);

    void displayName;
  });

  setSocketServer(io);

  // --- background jobs -----------------------------------------------------

  /**
   * Ephemeral expiry must not depend on anyone having the app open, otherwise a
   * "self-destruct in 30s" message would survive indefinitely while both users
   * are away.
   */
  const purgeTimer = setInterval(() => {
    void purgeExpiredMessages()
      .then((result) => {
        for (const purged of result.purgedIds) {
          io.to(SOCKET_ROOMS.chat(purged.chatId)).emit('ephemeral:purged', {
            messageId: purged.messageId,
            chatId: purged.chatId,
          });
        }
      })
      .catch((error: unknown) => log.error('Ephemeral sweep failed', { error }));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();

  /** Revoking a device should also sever its realtime channel. */
  const auditTimer = setInterval(() => {
    void (async () => {
      for (const [, socket] of io.sockets.sockets) {
        const typed = socket as DuoSocket;
        if (!typed.data.auth) continue;
        const valid = await isSessionStillValid(typed.data.auth.sessionId).catch(() => true);
        if (!valid) {
          typed.emit('session:revoked', { reason: 'Your session was revoked' });
          typed.disconnect(true);
        }
      }
    })();
  }, SESSION_AUDIT_INTERVAL_MS);
  auditTimer.unref?.();

  const maintenanceTimer = setInterval(() => {
    void (async () => {
      try {
        const [sessions, buckets, orphans, errors] = await Promise.all([
          pruneExpiredSessions(),
          pruneRateLimitBuckets(),
          pruneOrphanAttachments(),
          // Diagnostic noise, not user data: a busy week must not fill the disk.
          pruneErrorLogs(),
        ]);
        log.info('Maintenance complete', { sessions, buckets, orphans, errors });
      } catch (error) {
        log.error('Maintenance failed', { error });
      }
    })();
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  const shutdown = async (): Promise<void> => {
    clearInterval(purgeTimer);
    clearInterval(auditTimer);
    clearInterval(maintenanceTimer);

    // Mark everyone offline so the other person does not see a stale green dot
    // until the next heartbeat times out.
    await db.profile
      .updateMany({ where: { presence: { not: 'OFFLINE' } }, data: { presence: 'OFFLINE' } })
      .catch(() => undefined);

    await new Promise<void>((resolve) => io.close(() => resolve()));
  };

  return { io, shutdown };
}
