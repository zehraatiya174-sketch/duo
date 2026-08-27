import { createLogger } from '@/lib/logger';
import {
  completeViewSession,
  markViewRendered,
  recordSuspiciousView,
  releaseViewSession,
  reserveEphemeralView,
  type SettleViewResult,
} from '@/services/ephemeral';
import type { EphemeralSessionDTO, ViewSettlementDTO } from '@/types/models';
import { SOCKET_ROOMS } from '@/types/socket';

import type { DuoServer, DuoSocket } from '../context';

import { ack, guard } from './shared';

const log = createLogger('socket:ephemeral');

function toSettlement(result: SettleViewResult): ViewSettlementDTO {
  return {
    messageId: result.messageId,
    state: result.state,
    remainingViews: result.remainingViews,
    viewCount: result.viewCount,
    purged: result.purged,
  };
}

/**
 * The view-session lifecycle for sealed messages.
 *
 * Opening a message is not one event but four, because the interesting failures
 * all live in the gaps between them:
 *
 *   open      reserve the allowance and serve the content
 *   rendered  the media actually painted — past here the look is owed
 *   complete  the viewer closed; charge it, and destroy if it was the last
 *   release   nothing ever painted; hand the allowance back
 *
 * A single "viewed" event cannot distinguish a look that was taken from one
 * that failed to load, and would charge both. The lease in
 * `lib/ephemeral/session.ts` is the backstop for a client that never sends any
 * of the closing three.
 */
export function registerEphemeralHandlers(io: DuoServer, socket: DuoSocket): void {
  const { userId } = socket.data.auth;

  /** Tells the sender their message was looked at. */
  const notifyViewed = (result: SettleViewResult): void => {
    io.to(SOCKET_ROOMS.user(result.authorId)).emit('ephemeral:viewed', {
      messageId: result.messageId,
      chatId: result.chatId,
      viewerId: userId,
      viewCount: result.viewCount,
      remainingViews: result.remainingViews,
      at: new Date().toISOString(),
    });

    if (result.purged) {
      io.to(SOCKET_ROOMS.chat(result.chatId)).emit('ephemeral:purged', {
        messageId: result.messageId,
        chatId: result.chatId,
      });
    }
  };

  socket.on(
    'ephemeral:open',
    guard<{ messageId: string }, EphemeralSessionDTO>(
      socket,
      'ephemeral:open',
      async (raw, respond) => {
        const messageId = String(raw?.messageId ?? '');
        const result = await reserveEphemeralView(userId, messageId, {
          // `handshake.address` is the proxy on a hosted deployment; it is kept
          // for the audit trail rather than trusted as an identity.
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent'] ?? null,
        });

        respond(
          ack.ok({
            message: result.message,
            sessionId: result.sessionId,
            leaseExpiresAt: result.leaseExpiresAt?.toISOString() ?? null,
            remainingViews: result.remainingViews,
          }),
        );
      },
    ),
  );

  socket.on(
    'ephemeral:rendered',
    guard<{ messageId: string; sessionId: string }, ViewSettlementDTO | null>(
      socket,
      'ephemeral:rendered',
      async (raw, respond) => {
        const result = await markViewRendered(
          userId,
          String(raw?.messageId ?? ''),
          String(raw?.sessionId ?? ''),
        );
        respond(ack.ok(result ? toSettlement(result) : null));
      },
    ),
  );

  socket.on(
    'ephemeral:complete',
    guard<{ messageId: string; sessionId: string }, ViewSettlementDTO | null>(
      socket,
      'ephemeral:complete',
      async (raw, respond) => {
        const result = await completeViewSession(
          userId,
          String(raw?.messageId ?? ''),
          String(raw?.sessionId ?? ''),
        );

        respond(ack.ok(result ? toSettlement(result) : null));
        if (result) notifyViewed(result);
      },
    ),
  );

  socket.on(
    'ephemeral:release',
    guard<{ messageId: string; sessionId: string; reason?: string }, ViewSettlementDTO | null>(
      socket,
      'ephemeral:release',
      async (raw, respond) => {
        const result = await releaseViewSession(
          userId,
          String(raw?.messageId ?? ''),
          String(raw?.sessionId ?? ''),
          String(raw?.reason ?? 'closed'),
        );

        respond(ack.ok(result ? toSettlement(result) : null));

        // A release that got charged anyway — the budget ran out — is a real
        // view and the sender is told about it like any other.
        if (result?.state === 'COMPLETED') notifyViewed(result);
      },
    ),
  );

  /**
   * Fire-and-forget: the client reports focus loss, a print attempt or a screen
   * capture API call. Advisory only — none of it can be enforced, and treating
   * it as enforcement would give the sender false confidence.
   */
  socket.on('ephemeral:suspicion', (raw) => {
    void (async () => {
      try {
        const messageId = String(raw?.messageId ?? '');
        const reason = raw?.reason;
        if (!messageId || !reason) return;

        const result = await recordSuspiciousView(userId, messageId, reason);
        if (!result) return;

        io.to(SOCKET_ROOMS.user(result.authorId)).emit('ephemeral:suspicion', {
          messageId,
          chatId: result.chatId,
          viewerId: userId,
          reason,
          at: new Date().toISOString(),
        });
      } catch (error) {
        log.warn('Could not record a suspicious view', { userId, error });
      }
    })();
  });
}
