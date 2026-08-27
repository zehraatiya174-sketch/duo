import { AppError, conflict, forbidden, notFound } from '@/lib/errors';
import { db } from '@/lib/db';
import {
  MAX_RELEASES_PER_VIEWER,
  VIEW_LEASE_SECONDS,
  countConsumed,
  isSessionActive,
} from '@/lib/ephemeral/session';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { messageInclude, serializeMessage } from '@/lib/serializers/message';
import type { MessageDTO } from '@/types/models';

import { assertChatMember } from './messages';

const log = createLogger('ephemeral');

export interface OpenEphemeralResult {
  message: MessageDTO;
  chatId: string;
  authorId: string;
  viewCount: number;
  remainingViews: number | null;
  /** Identifies the reserved look, so the client can settle it afterwards. */
  sessionId: string | null;
  /** When the reservation lapses if the client goes quiet. */
  leaseExpiresAt: Date | null;
  /**
   * Always false on reservation. Destruction is deferred until a look is
   * actually completed — that deferral is the whole point of the session model.
   */
  purged: boolean;
  viewedAt: Date;
}

export interface OpenContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Outcome of settling a look that was previously reserved. */
export interface SettleViewResult {
  chatId: string;
  authorId: string;
  messageId: string;
  state: 'COMPLETED' | 'RELEASED' | 'RENDERED';
  remainingViews: number | null;
  viewCount: number;
  purged: boolean;
}

/**
 * Reserves one look at an ephemeral message and reveals its content.
 *
 * This is the only code path that may unseal content, and it deliberately does
 * *not* destroy anything. An earlier version spent the allowance and purged the
 * media in this same request, which meant a view-once photo had its bytes
 * deleted from storage before the browser had finished fetching them: the
 * reader was shown "destroyed" and never saw the picture at all.
 *
 * So a look is a session. Reserving holds the allowance — enough to stop a
 * second tab spending the same view — while leaving the media intact. The look
 * is only charged once {@link completeViewSession} confirms it happened, or the
 * lease lapses on a session that had already reported a successful render.
 *
 * Re-entering an active session is idempotent, which is what lets a reader
 * refresh the page mid-view without being charged twice.
 */
export async function reserveEphemeralView(
  userId: string,
  messageId: string,
  context: OpenContext = {},
): Promise<OpenEphemeralResult> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    include: messageInclude,
  });
  if (!message) throw notFound('Message not found');
  await assertChatMember(message.chatId, userId);

  if (message.deletedForAll || message.purgedAt) {
    throw new AppError('GONE', 'This message is no longer available');
  }

  if (message.ephemeralMode === 'NORMAL') {
    // Nothing to consume — return it as an ordinary read.
    return {
      message: serializeMessage(message, userId),
      chatId: message.chatId,
      authorId: message.authorId,
      viewCount: message.viewCount,
      remainingViews: null,
      sessionId: null,
      leaseExpiresAt: null,
      purged: false,
      viewedAt: new Date(),
    };
  }

  const now = new Date();

  if (message.expiresAt && message.expiresAt <= now) {
    await purgeMessage(messageId, 'expired');
    throw new AppError('EPHEMERAL_EXPIRED', 'This message has expired');
  }

  if (
    message.destructAfterSeconds !== null &&
    message.destructStartedAt !== null &&
    message.destructStartedAt.getTime() + message.destructAfterSeconds * 1000 <= now.getTime()
  ) {
    await purgeMessage(messageId, 'self-destructed');
    throw new AppError('EPHEMERAL_EXPIRED', 'This message has self-destructed');
  }

  // The author re-reading their own message never consumes an allowance.
  if (message.authorId === userId) {
    return {
      message: serializeMessage(message, userId, { revealEphemeral: true }),
      chatId: message.chatId,
      authorId: message.authorId,
      viewCount: message.viewCount,
      remainingViews: message.maxViews,
      sessionId: null,
      leaseExpiresAt: null,
      purged: false,
      viewedAt: now,
    };
  }

  const leaseExpiresAt = new Date(now.getTime() + VIEW_LEASE_SECONDS * 1000);

  const { updated, sessionId } = await db.$transaction(async (tx) => {
    // Re-read inside the transaction so two concurrent opens cannot both slip
    // past the allowance check.
    const fresh = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { maxViews: true, purgedAt: true },
    });

    if (fresh.purgedAt) {
      throw new AppError('GONE', 'This message is no longer available');
    }

    const sessions = await tx.messageView.findMany({
      where: { messageId, userId },
      select: { id: true, state: true, leaseExpiresAt: true, renderedAt: true },
    });

    // A reader who refreshes mid-view rejoins the look they already hold rather
    // than paying for a second one.
    const live = sessions.find((session) => isSessionActive(session, now.getTime()));
    if (live) {
      const rejoined = await tx.messageView.update({
        where: { id: live.id },
        data: { leaseExpiresAt },
        select: { id: true },
      });
      const message = await tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: messageInclude,
      });
      return { updated: message, sessionId: rejoined.id };
    }

    const { consumed } = countConsumed(sessions, now.getTime());
    if (fresh.maxViews !== null && consumed >= fresh.maxViews) {
      throw new AppError('EPHEMERAL_EXHAUSTED', 'You have already viewed this message');
    }

    const created = await tx.messageView.create({
      data: {
        messageId,
        userId,
        viewedAt: now,
        state: 'RESERVED',
        reservedAt: now,
        leaseExpiresAt,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
      select: { id: true },
    });

    const message = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
      include: messageInclude,
    });

    return { updated: message, sessionId: created.id };
  });

  const remaining =
    updated.maxViews === null
      ? null
      : Math.max(
          0,
          updated.maxViews -
            countConsumed(
              updated.views.filter((v) => v.userId === userId),
              now.getTime(),
            ).consumed,
        );

  const revealed = serializeMessage(updated, userId, { revealEphemeral: true });

  await db.auditLog.create({
    data: {
      userId,
      action: 'EPHEMERAL_VIEWED',
      metadata: { messageId, sessionId, remaining, phase: 'reserved' },
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    },
  });

  return {
    message: revealed,
    chatId: updated.chatId,
    authorId: updated.authorId,
    viewCount: updated.viewCount,
    remainingViews: remaining,
    sessionId,
    leaseExpiresAt,
    purged: false,
    viewedAt: now,
  };
}

/**
 * Records that the media actually painted on the reader's screen.
 *
 * This is the point of no return: everything before it can be handed back, and
 * nothing after it can. It is also where the self-destruct countdown starts,
 * because a countdown that began at reservation would be partly spent on
 * network transfer the reader never saw.
 */
export async function markViewRendered(
  userId: string,
  messageId: string,
  sessionId: string,
): Promise<SettleViewResult | null> {
  const now = new Date();

  const session = await db.messageView.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, messageId: true, state: true, leaseExpiresAt: true },
  });
  if (!session || session.userId !== userId || session.messageId !== messageId) return null;
  if (session.state !== 'RESERVED') return null;

  await db.$transaction(async (tx) => {
    await tx.messageView.update({
      where: { id: sessionId },
      data: { state: 'RENDERED', renderedAt: now },
    });

    const message = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { destructAfterSeconds: true, destructStartedAt: true },
    });

    if (message.destructAfterSeconds !== null && message.destructStartedAt === null) {
      await tx.message.update({
        where: { id: messageId },
        data: { destructStartedAt: now },
      });
    }
  });

  return summarise(messageId, userId, 'RENDERED', false);
}

/**
 * Charges a look and, if that was the last one, destroys the message.
 *
 * Called when the viewer closes. Destruction happens here rather than at
 * reservation because only now is the reader known to have had their look.
 */
export async function completeViewSession(
  userId: string,
  messageId: string,
  sessionId: string,
): Promise<SettleViewResult | null> {
  const now = new Date();

  const session = await db.messageView.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, messageId: true, state: true },
  });
  if (!session || session.userId !== userId || session.messageId !== messageId) return null;
  if (session.state === 'COMPLETED') return summarise(messageId, userId, 'COMPLETED', false);
  if (session.state === 'RELEASED') return null;

  await db.$transaction(async (tx) => {
    await tx.messageView.update({
      where: { id: sessionId },
      data: { state: 'COMPLETED', completedAt: now, viewedAt: now },
    });
    await tx.message.update({
      where: { id: messageId },
      data: { viewCount: { increment: 1 } },
    });
  });

  const purged = await purgeIfExhausted(messageId);
  return summarise(messageId, userId, 'COMPLETED', purged);
}

/**
 * Hands an allowance back after a look that never happened.
 *
 * Only a session that never reported a render qualifies, and only while the
 * reader is under their refund budget — past that the abandonment is charged,
 * which is what stops "fail the request forever" being a way to re-read a
 * view-once photo without limit.
 */
export async function releaseViewSession(
  userId: string,
  messageId: string,
  sessionId: string,
  reason: string,
): Promise<SettleViewResult | null> {
  const now = new Date();

  const session = await db.messageView.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, messageId: true, state: true },
  });
  if (!session || session.userId !== userId || session.messageId !== messageId) return null;
  if (session.state === 'COMPLETED' || session.state === 'RELEASED') return null;

  // A session that already painted has had its look; closing it is a completion
  // however the client chooses to describe it.
  if (session.state === 'RENDERED') {
    return completeViewSession(userId, messageId, sessionId);
  }

  const priorReleases = await db.messageView.count({
    where: { messageId, userId, state: 'RELEASED' },
  });

  if (priorReleases >= MAX_RELEASES_PER_VIEWER) {
    log.warn('Release budget exhausted; charging the look', { messageId, userId, reason });
    return completeViewSession(userId, messageId, sessionId);
  }

  await db.messageView.update({
    where: { id: sessionId },
    data: { state: 'RELEASED', completedAt: now },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: 'EPHEMERAL_VIEWED',
      metadata: { messageId, sessionId, phase: 'released', reason },
    },
  });

  return summarise(messageId, userId, 'RELEASED', false);
}

/** Shared tail: recomputes what the reader has left and who needs telling. */
async function summarise(
  messageId: string,
  userId: string,
  state: SettleViewResult['state'],
  purged: boolean,
): Promise<SettleViewResult | null> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      chatId: true,
      authorId: true,
      maxViews: true,
      viewCount: true,
      views: {
        where: { userId },
        select: { state: true, leaseExpiresAt: true },
      },
    },
  });
  if (!message) return null;

  const remaining =
    message.maxViews === null
      ? null
      : Math.max(0, message.maxViews - countConsumed(message.views).consumed);

  return {
    chatId: message.chatId,
    authorId: message.authorId,
    messageId,
    state,
    remainingViews: remaining,
    viewCount: message.viewCount,
    purged,
  };
}

/**
 * Destroys a message once every recipient has spent every look.
 *
 * Only completed sessions count. A held reservation deliberately does not keep
 * the message alive forever either — the lease sweep settles it first.
 */
async function purgeIfExhausted(messageId: string): Promise<boolean> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: { id: true, chatId: true, authorId: true, maxViews: true, purgedAt: true },
  });
  if (!message || message.purgedAt || message.maxViews === null) return false;

  const recipients = await db.chatMember.findMany({
    where: { chatId: message.chatId, userId: { not: message.authorId } },
    select: { userId: true },
  });

  for (const recipient of recipients) {
    const sessions = await db.messageView.findMany({
      where: { messageId, userId: recipient.userId },
      select: { state: true, leaseExpiresAt: true },
    });
    const { spent, held } = countConsumed(sessions);
    // Someone still has an unspent look, or is in the middle of one.
    if (spent + held < message.maxViews || held > 0) return false;
  }

  return purgeMessage(messageId, 'views-exhausted');
}

/**
 * Permanently destroys a message's content and its media.
 *
 * The row itself survives as a tombstone so the timeline keeps its ordering and
 * reply chains do not dangle. When `DESTROY_EPHEMERAL_METADATA` is enabled the
 * view audit trail and attachment metadata rows are removed too.
 */
export async function purgeMessage(messageId: string, reason: string): Promise<boolean> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: { id: true, chatId: true, purgedAt: true, authorId: true },
  });
  if (!message || message.purgedAt) return false;

  const destroyMetadata = serverEnv().DESTROY_EPHEMERAL_METADATA;

  // Blob deletion first: if the storage provider is down we want to know before
  // we have thrown away the keys needed to retry.
  const { purgeAttachmentsForMessage } = await import('./storage');
  await purgeAttachmentsForMessage(messageId).catch((error: unknown) => {
    log.error('Storage purge failed during ephemeral destruction', { error, messageId });
  });

  await db.$transaction(async (tx) => {
    await tx.message.update({
      where: { id: messageId },
      data: {
        purgedAt: new Date(),
        body: null,
        bodyText: null,
        codeLanguage: null,
        locationLat: null,
        locationLng: null,
        locationLabel: null,
      },
    });

    await tx.linkPreview.deleteMany({ where: { messageId } });
    await tx.reaction.deleteMany({ where: { messageId } });
    await tx.pinnedMessage.deleteMany({ where: { messageId } });

    if (destroyMetadata) {
      await tx.messageView.deleteMany({ where: { messageId } });
      await tx.attachment.deleteMany({ where: { messageId } });
    }

    await tx.auditLog.create({
      data: {
        userId: message.authorId,
        action: 'EPHEMERAL_PURGED',
        metadata: { messageId, reason, destroyedMetadata: destroyMetadata },
      },
    });
  });

  log.info('Purged ephemeral message', { messageId, reason });
  return true;
}

export interface PurgeSweepResult {
  expired: number;
  selfDestructed: number;
  /** Reservations settled because their lease ran out. */
  settledSessions: number;
  purgedIds: Array<{ messageId: string; chatId: string }>;
}

/**
 * Settles looks whose lease ran out while the client was silent.
 *
 * The two cases are decided differently, and the difference is the whole safety
 * argument. A session that reported a render is charged: the reader saw the
 * media, and a closed laptop must not refund it. A session that never rendered
 * is handed back, because nothing was ever shown — unless the reader has
 * already spent their refund budget, at which point silence starts costing.
 */
export async function settleExpiredViewSessions(): Promise<{
  committed: number;
  released: number;
  purgedIds: Array<{ messageId: string; chatId: string }>;
}> {
  const now = new Date();
  const purgedIds: Array<{ messageId: string; chatId: string }> = [];

  const stale = await db.messageView.findMany({
    where: {
      state: { in: ['RESERVED', 'RENDERED'] },
      leaseExpiresAt: { lte: now },
    },
    select: { id: true, messageId: true, userId: true, state: true },
    take: 500,
  });

  let committed = 0;
  let released = 0;

  for (const session of stale) {
    if (session.state === 'RENDERED') {
      const result = await completeViewSession(session.userId, session.messageId, session.id);
      committed += 1;
      if (result?.purged) purgedIds.push({ messageId: session.messageId, chatId: result.chatId });
      continue;
    }

    const result = await releaseViewSession(
      session.userId,
      session.messageId,
      session.id,
      'lease-expired',
    );
    if (result?.state === 'RELEASED') released += 1;
    else committed += 1;
    if (result?.purged) purgedIds.push({ messageId: session.messageId, chatId: result.chatId });
  }

  if (stale.length > 0) {
    log.info('Settled expired view sessions', { committed, released });
  }

  return { committed, released, purgedIds };
}

/**
 * Sweeps everything whose time is up. Runs on a timer in the realtime server so
 * expiry is enforced even when nobody opens the app.
 */
export async function purgeExpiredMessages(): Promise<PurgeSweepResult> {
  const now = new Date();
  const purgedIds: Array<{ messageId: string; chatId: string }> = [];

  // Settle abandoned looks first: a reservation that has just been charged may
  // be the one that exhausts a message, and this pass should catch it.
  const settled = await settleExpiredViewSessions();
  purgedIds.push(...settled.purgedIds);

  const expired = await db.message.findMany({
    where: { purgedAt: null, expiresAt: { lte: now } },
    select: { id: true, chatId: true },
    take: 200,
  });

  for (const row of expired) {
    if (await purgeMessage(row.id, 'expired')) {
      purgedIds.push({ messageId: row.id, chatId: row.chatId });
    }
  }

  // Countdown-based destruction cannot be expressed as a single indexed
  // predicate, so we narrow with the cheap conditions and finish in memory.
  const candidates = await db.message.findMany({
    where: {
      purgedAt: null,
      destructStartedAt: { not: null },
      destructAfterSeconds: { not: null },
    },
    select: { id: true, chatId: true, destructStartedAt: true, destructAfterSeconds: true },
    take: 500,
  });

  let selfDestructed = 0;
  for (const row of candidates) {
    if (!row.destructStartedAt || row.destructAfterSeconds === null) continue;
    const deadline = row.destructStartedAt.getTime() + row.destructAfterSeconds * 1000;
    if (deadline > now.getTime()) continue;
    if (await purgeMessage(row.id, 'self-destructed')) {
      purgedIds.push({ messageId: row.id, chatId: row.chatId });
      selfDestructed += 1;
    }
  }

  if (purgedIds.length > 0) {
    log.info('Ephemeral sweep complete', { expired: expired.length, selfDestructed });
  }

  return {
    expired: expired.length,
    selfDestructed,
    settledSessions: settled.committed + settled.released,
    purgedIds,
  };
}

/**
 * Records a possible capture attempt reported by the recipient's browser.
 *
 * Browsers cannot reliably block screenshots, so this is detection rather than
 * prevention: the sender is told that the recipient's tab lost focus or invoked
 * a capture API while their disappearing media was open.
 */
export async function recordSuspiciousView(
  userId: string,
  messageId: string,
  reason: string,
): Promise<{ chatId: string; authorId: string } | null> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    select: { id: true, chatId: true, authorId: true, ephemeralMode: true },
  });
  if (!message || message.ephemeralMode === 'NORMAL') return null;
  if (message.authorId === userId) return null;

  const latest = await db.messageView.findFirst({
    where: { messageId, userId },
    orderBy: { viewedAt: 'desc' },
    select: { id: true },
  });
  if (latest) {
    await db.messageView.update({ where: { id: latest.id }, data: { suspicious: true } });
  }

  await db.auditLog.create({
    data: {
      userId,
      action: 'SUSPICIOUS_ACTIVITY',
      metadata: { messageId, reason },
    },
  });

  return { chatId: message.chatId, authorId: message.authorId };
}

/** Blocks a recipient from reading sealed content through any other route. */
export async function assertMayReadAttachment(userId: string, attachmentId: string): Promise<void> {
  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      purgedAt: true,
      uploaderId: true,
      message: {
        select: {
          id: true,
          chatId: true,
          authorId: true,
          ephemeralMode: true,
          maxViews: true,
          expiresAt: true,
          purgedAt: true,
          deletedForAll: true,
          destructAfterSeconds: true,
          destructStartedAt: true,
          views: {
            where: { userId },
            select: { id: true, state: true, leaseExpiresAt: true },
          },
        },
      },
    },
  });

  if (!attachment) throw notFound('Attachment not found');
  if (attachment.purgedAt) throw new AppError('GONE', 'This media has been destroyed');

  const message = attachment.message;

  // An attachment with no message is a pending upload; only its uploader may
  // read it back (for the composer preview).
  if (!message) {
    if (attachment.uploaderId !== userId) throw forbidden('Not your upload');
    return;
  }

  await assertChatMember(message.chatId, userId);

  if (message.deletedForAll || message.purgedAt) {
    throw new AppError('GONE', 'This media has been destroyed');
  }

  if (message.ephemeralMode === 'NORMAL') return;
  if (message.authorId === userId) return;

  const now = Date.now();
  if (message.expiresAt && message.expiresAt.getTime() <= now) {
    throw new AppError('EPHEMERAL_EXPIRED', 'This media has expired');
  }
  if (
    message.destructAfterSeconds !== null &&
    message.destructStartedAt !== null &&
    message.destructStartedAt.getTime() + message.destructAfterSeconds * 1000 <= now
  ) {
    throw new AppError('EPHEMERAL_EXPIRED', 'This media has self-destructed');
  }

  // Sealed media is readable only while the recipient holds a live reservation.
  //
  // Binding the fetch to an *active* session rather than to a count of past
  // opens is what makes the whole thing work: the bytes stay reachable for as
  // long as the viewer is actually on screen, and stop being reachable the
  // moment it closes. Under the old count-based rule the media was deleted in
  // the same request that unsealed it, so the image never arrived at all.
  if (message.views.length === 0) {
    throw conflict('Open this message before loading its media');
  }
  if (!message.views.some((view) => isSessionActive(view))) {
    throw new AppError('EPHEMERAL_EXHAUSTED', 'You have already viewed this media');
  }
}
