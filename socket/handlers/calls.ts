import { db } from '@/lib/db';
import { forbidden, notFound } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { assertChatMember } from '@/services/messages';
import { SOCKET_ROOMS } from '@/types/socket';

import type { DuoServer, DuoSocket } from '../context';
import { isOnline } from '../presence';
import { ack, guard } from './shared';

const log = createLogger('socket:calls');

/** A ringing call that is never answered is marked missed after this long. */
const RING_TIMEOUT_MS = 45_000;

/**
 * How long a call survives its participant's socket going away.
 *
 * A phone switching from Wi-Fi to cellular drops the socket for a few seconds
 * while the media path carries on perfectly well. Ending the call the instant
 * signalling blinks would turn every handover into a dropped call, so the
 * teardown is deferred and cancelled if the user comes back.
 */
const SIGNALLING_GRACE_MS = 15_000;

const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dropTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelRingTimer(callId: string): void {
  const timer = ringTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(callId);
  }
}

/** Both participants' personal rooms, so an event lands wherever they are. */
async function callAudience(callId: string): Promise<string[]> {
  const participants = await db.callParticipant.findMany({
    where: { callId },
    select: { userId: true },
  });
  return participants.map((participant) => participant.userId);
}

async function emitToCall(
  io: DuoServer,
  callId: string,
  emit: (room: string) => void,
): Promise<void> {
  for (const participantId of await callAudience(callId)) {
    emit(SOCKET_ROOMS.user(participantId));
  }
}

/**
 * WebRTC signalling.
 *
 * The server only relays SDP and ICE — media never touches it. Its job is to
 * decide who is allowed to call whom, to keep the Call row in sync, and to
 * make sure an unanswered call resolves to MISSED rather than ringing forever.
 */
export function registerCallHandlers(io: DuoServer, socket: DuoSocket): void {
  const { userId } = socket.data.auth;

  socket.on(
    'call:invite',
    guard(socket, 'call:invite', async (raw, respond) => {
      const chatId = String(raw.chatId ?? '');
      const kind = raw.kind === 'VIDEO' || raw.kind === 'SCREEN_SHARE' ? raw.kind : 'AUDIO';
      const sdp = raw.sdp;

      if (!sdp?.type) {
        respond(ack.fail('BAD_REQUEST', 'Missing session description'));
        return;
      }

      await assertChatMember(chatId, userId);

      // Refuse to start a second call in a conversation that already has one.
      const active = await db.call.findFirst({
        where: { chatId, status: { in: ['RINGING', 'ONGOING'] } },
        select: { id: true },
      });
      if (active) {
        respond(ack.fail('CONFLICT', 'A call is already in progress'));
        return;
      }

      const members = await db.chatMember.findMany({
        where: { chatId },
        select: { userId: true },
      });
      const calleeIds = members.map((m) => m.userId).filter((id) => id !== userId);

      const call = await db.call.create({
        data: {
          chatId,
          initiatorId: userId,
          kind,
          status: 'RINGING',
          participants: {
            createMany: {
              data: [{ userId, joinedAt: new Date() }, ...calleeIds.map((id) => ({ userId: id }))],
            },
          },
        },
        select: { id: true },
      });

      respond(ack.ok({ callId: call.id }));

      const anyoneReachable = calleeIds.some((id) => isOnline(id));

      for (const calleeId of calleeIds) {
        io.to(SOCKET_ROOMS.user(calleeId)).emit('call:incoming', {
          callId: call.id,
          chatId,
          from: userId,
          kind,
          sdp,
        });

        await db.notification.create({
          data: {
            userId: calleeId,
            kind: 'CALL',
            title: `Incoming ${kind === 'VIDEO' ? 'video' : 'voice'} call`,
            body: socket.data.auth.displayName,
            href: '/',
          },
        });
      }

      await db.auditLog.create({
        data: { userId, action: 'CALL_STARTED', metadata: { callId: call.id, kind } },
      });

      if (!anyoneReachable) {
        await endCall(io, call.id, userId, 'unreachable', 'MISSED');
        return;
      }

      const timer = setTimeout(() => {
        void endCall(io, call.id, userId, 'no-answer', 'MISSED');
      }, RING_TIMEOUT_MS);
      timer.unref?.();
      ringTimers.set(call.id, timer);
    }),
  );

  socket.on(
    'call:answer',
    guard(socket, 'call:answer', async (raw, respond) => {
      const callId = String(raw.callId ?? '');
      const sdp = raw.sdp;
      if (!sdp?.type) {
        respond(ack.fail('BAD_REQUEST', 'Missing session description'));
        return;
      }

      const call = await db.call.findUnique({
        where: { id: callId },
        select: { id: true, chatId: true, initiatorId: true, status: true },
      });
      if (!call) throw notFound('Call not found');
      if (call.status !== 'RINGING') {
        respond(ack.fail('CONFLICT', 'This call is no longer ringing'));
        return;
      }
      await assertChatMember(call.chatId, userId);

      cancelRingTimer(callId);

      await db.$transaction([
        db.call.update({
          where: { id: callId },
          data: { status: 'ONGOING', answeredAt: new Date() },
        }),
        db.callParticipant.updateMany({
          where: { callId, userId },
          data: { joinedAt: new Date() },
        }),
      ]);

      respond(ack.ok({ callId }));
      io.to(SOCKET_ROOMS.user(call.initiatorId)).emit('call:answered', { callId, sdp });
    }),
  );

  // ICE candidates are high-frequency and fire-and-forget; they are relayed to
  // every other participant without a database round trip.
  socket.on('call:ice', (payload) => {
    void relayToPeers(io, userId, String(payload?.callId ?? ''), (peerId) => {
      io.to(SOCKET_ROOMS.user(peerId)).emit('call:ice', payload);
    });
  });

  socket.on('call:renegotiate', (payload) => {
    void relayToPeers(io, userId, String(payload?.callId ?? ''), (peerId) => {
      io.to(SOCKET_ROOMS.user(peerId)).emit('call:renegotiate', payload);
    });
  });

  socket.on('call:ringing', (payload) => {
    const callId = String(payload?.callId ?? '');
    void relayToPeers(io, userId, callId, (peerId) => {
      io.to(SOCKET_ROOMS.user(peerId)).emit('call:ringing', { callId, by: userId });
    });
  });

  socket.on('call:restart', (payload) => {
    const callId = String(payload?.callId ?? '');
    const reason = payload?.reason;
    void relayToPeers(io, userId, callId, (peerId) => {
      io.to(SOCKET_ROOMS.user(peerId)).emit('call:restart', {
        callId,
        by: userId,
        ...(reason ? { reason } : {}),
      });
    });
  });

  socket.on('call:decline', (payload) => {
    void (async () => {
      const callId = String(payload?.callId ?? '');
      cancelRingTimer(callId);
      const call = await db.call.findUnique({
        where: { id: callId },
        select: { chatId: true, initiatorId: true, status: true },
      });
      if (!call || call.status === 'ENDED') return;

      await db.call.update({
        where: { id: callId },
        data: { status: 'DECLINED', endedAt: new Date(), endReason: 'declined' },
      });

      // Addressed to the participants themselves rather than to the chat room:
      // the caller may well be looking at a different conversation, and a
      // decline that never arrives leaves them ringing into nothing.
      await emitToCall(io, callId, (room) => {
        io.to(room).emit('call:declined', { callId, by: userId });
      });
    })();
  });

  socket.on('call:end', (payload) => {
    void endCall(io, String(payload?.callId ?? ''), userId, String(payload?.reason ?? 'hangup'));
  });

  socket.on('call:stats', (payload) => {
    void (async () => {
      try {
        const callId = String(payload?.callId ?? '');
        if (!callId || !payload?.stats) return;
        await db.callParticipant.updateMany({
          where: { callId, userId },
          data: { quality: payload.stats },
        });
      } catch (error) {
        log.debug('Failed to record call stats', { error });
      }
    })();
  });
}

async function relayToPeers(
  io: DuoServer,
  userId: string,
  callId: string,
  send: (peerId: string) => void,
): Promise<void> {
  if (!callId) return;
  try {
    const participants = await db.callParticipant.findMany({
      where: { callId },
      select: { userId: true },
    });
    if (!participants.some((p) => p.userId === userId)) throw forbidden('Not part of this call');
    for (const participant of participants) {
      if (participant.userId !== userId) send(participant.userId);
    }
  } catch (error) {
    log.debug('Call relay failed', { error, callId });
  }
}

/** Terminates a call, records its duration, and tells everyone. */
export async function endCall(
  io: DuoServer,
  callId: string,
  byUserId: string,
  reason: string,
  status: 'ENDED' | 'MISSED' | 'FAILED' = 'ENDED',
): Promise<void> {
  if (!callId) return;
  cancelRingTimer(callId);

  try {
    const call = await db.call.findUnique({
      where: { id: callId },
      select: {
        id: true,
        chatId: true,
        status: true,
        startedAt: true,
        answeredAt: true,
        initiatorId: true,
      },
    });
    if (!call || ['ENDED', 'MISSED', 'DECLINED', 'FAILED'].includes(call.status)) return;

    const endedAt = new Date();
    const answeredAt = call.answeredAt;
    const durationSec = answeredAt
      ? Math.max(0, Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000))
      : 0;

    const finalStatus = status === 'ENDED' && !answeredAt ? 'MISSED' : status;

    await db.$transaction([
      db.call.update({
        where: { id: callId },
        data: { status: finalStatus, endedAt, durationSec, endReason: reason },
      }),
      db.callParticipant.updateMany({
        where: { callId, leftAt: null },
        data: { leftAt: endedAt },
      }),
      db.auditLog.create({
        data: {
          userId: byUserId,
          action: 'CALL_ENDED',
          metadata: { callId, reason, durationSec, status: finalStatus },
        },
      }),
    ]);

    await emitToCall(io, callId, (room) => {
      io.to(room).emit('call:ended', { callId, reason, by: byUserId });
    });

    if (finalStatus === 'MISSED') {
      const participants = await db.callParticipant.findMany({
        where: { callId, userId: { not: call.initiatorId } },
        select: { userId: true },
      });
      for (const participant of participants) {
        await db.notification.create({
          data: {
            userId: participant.userId,
            kind: 'MISSED_CALL',
            title: 'Missed call',
            body: reason === 'unreachable' ? 'They were not reachable' : 'You missed a call',
            href: '/',
          },
        });
      }
    }
  } catch (error) {
    log.error('Failed to end call', { error, callId });
  }
}

/**
 * Ends any calls a disconnecting user was part of — after a grace period.
 *
 * The delay is the whole point. Signalling and media travel independently, so a
 * socket that drops during a network handover says nothing about whether the
 * call is still up; the peer connection very often survives it. Waiting lets
 * the reconnect cancel the teardown, and only a genuine departure gets as far
 * as actually ending the call.
 */
export function endCallsForUser(io: DuoServer, userId: string): void {
  cancelPendingCallTeardown(userId);

  const timer = setTimeout(() => {
    dropTimers.delete(userId);
    void (async () => {
      if (isOnline(userId)) return;
      const active = await db.call.findMany({
        where: {
          status: { in: ['RINGING', 'ONGOING'] },
          participants: { some: { userId } },
        },
        select: { id: true },
      });
      for (const call of active) {
        await endCall(io, call.id, userId, 'peer-disconnected');
      }
    })();
  }, SIGNALLING_GRACE_MS);

  timer.unref?.();
  dropTimers.set(userId, timer);
}

/** Called when a user reconnects, so a blip does not cost them the call. */
export function cancelPendingCallTeardown(userId: string): void {
  const timer = dropTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    dropTimers.delete(userId);
  }
}
