import { Prisma, type AttachmentKind, type AuditAction, type CallKind, type CallStatus } from '@prisma/client';

import { checkDatabaseHealth, db } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { connectionCount, onlineUserIds } from '@/socket/presence';
import type { Page } from '@/types/models';

import { storageUsage } from './storage';

/** Midnight UTC, `daysAgo` days back. The left edge of every daily series. */
function startOfDayUtc(daysAgo: number): Date {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/**
 * Counts timestamps into consecutive UTC days.
 *
 * Bucketing in memory keeps these series portable across database engines, and
 * the windows are short enough — a fortnight at most — that the row count stays
 * trivially small.
 */
function bucketByDay(
  timestamps: readonly Date[],
  since: Date,
  days: number,
): Array<[string, number]> {
  const buckets = new Map<string, number>();
  for (let day = 0; day < days; day += 1) {
    const date = new Date(since.getTime() + day * 24 * 60 * 60 * 1000);
    buckets.set(date.toISOString().slice(0, 10), 0);
  }
  for (const timestamp of timestamps) {
    const key = timestamp.toISOString().slice(0, 10);
    const current = buckets.get(key);
    if (current !== undefined) buckets.set(key, current + 1);
  }
  return [...buckets.entries()];
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  banned: boolean;
  createdAt: string;
  username: string | null;
  presence: string | null;
  lastSeenAt: string | null;
  sessionCount: number;
  deviceCount: number;
  messageCount: number;
  online: boolean;
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const online = new Set(onlineUserIds());

  const users = await db.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      profile: { select: { username: true, presence: true, lastSeenAt: true } },
      _count: { select: { sessions: true, devices: true, messages: true } },
    },
  });

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    banned: user.banned,
    createdAt: user.createdAt.toISOString(),
    username: user.profile?.username ?? null,
    presence: user.profile?.presence ?? null,
    lastSeenAt: user.profile?.lastSeenAt.toISOString() ?? null,
    sessionCount: user._count.sessions,
    deviceCount: user._count.devices,
    messageCount: user._count.messages,
    online: online.has(user.id),
  }));
}

export interface AdminSessionRow {
  id: string;
  userId: string;
  userEmail: string;
  expiresAt: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  device: { id: string; label: string; browser: string | null; os: string | null } | null;
}

export async function listActiveSessions(): Promise<AdminSessionRow[]> {
  const sessions = await db.session.findMany({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { email: true } },
      device: { select: { id: true, label: true, browser: true, os: true } },
    },
  });

  return sessions.map((session) => ({
    id: session.id,
    userId: session.userId,
    userEmail: session.user.email,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    device: session.device,
  }));
}

export interface AdminDeviceRow {
  id: string;
  userId: string;
  userEmail: string;
  label: string;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  ipAddress: string | null;
  location: string | null;
  trusted: boolean;
  lastActiveAt: string;
  createdAt: string;
  /** Whether the session this device was registered against is still alive. */
  sessionActive: boolean;
  /** Whether the owner has a socket open right now. */
  online: boolean;
}

/** Every device either account has ever signed in from. */
export async function listDevices(): Promise<AdminDeviceRow[]> {
  const online = new Set(onlineUserIds());
  const now = new Date();

  const devices = await db.device.findMany({
    orderBy: { lastActiveAt: 'desc' },
    include: {
      user: { select: { email: true } },
      session: { select: { expiresAt: true } },
    },
  });

  return devices.map((device) => ({
    id: device.id,
    userId: device.userId,
    userEmail: device.user.email,
    label: device.label,
    browser: device.browser,
    os: device.os,
    deviceType: device.deviceType,
    ipAddress: device.ipAddress,
    location: device.location,
    trusted: device.trusted,
    lastActiveAt: device.lastActiveAt.toISOString(),
    createdAt: device.createdAt.toISOString(),
    sessionActive: Boolean(device.session && device.session.expiresAt > now),
    online: online.has(device.userId),
  }));
}

export interface AdminCallRow {
  id: string;
  kind: CallKind;
  status: CallStatus;
  initiatorEmail: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  endReason: string | null;
  participants: number;
  /** Last reported link quality, when a participant sent one. */
  quality: { rttMs: number | null; lossRatio: number | null; transport: string | null } | null;
}

/** Reads the numeric field `key` out of a stored stats snapshot. */
function statNumber(quality: Prisma.JsonValue | null, key: string): number | null {
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) return null;
  const value = (quality as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function statString(quality: Prisma.JsonValue | null, key: string): string | null {
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) return null;
  const value = (quality as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The call log.
 *
 * Only the envelope is recorded — who rang whom, when, for how long, and how
 * the link behaved. No call is ever recorded, so there is nothing here that
 * could expose what was said.
 */
export async function listCalls(input: {
  cursor?: string | null;
  limit?: number;
  status?: CallStatus;
}): Promise<Page<AdminCallRow>> {
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 200);

  const rows = await db.call.findMany({
    where: input.status ? { status: input.status } : {},
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: {
      initiator: { select: { email: true } },
      participants: { select: { quality: true }, orderBy: { joinedAt: 'desc' } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((call) => {
      const reported = call.participants.find((participant) => participant.quality !== null);
      return {
        id: call.id,
        kind: call.kind,
        status: call.status,
        initiatorEmail: call.initiator.email,
        startedAt: call.startedAt.toISOString(),
        answeredAt: call.answeredAt?.toISOString() ?? null,
        endedAt: call.endedAt?.toISOString() ?? null,
        durationSec: call.durationSec,
        endReason: call.endReason,
        participants: call.participants.length,
        quality: reported
          ? {
              rttMs: statNumber(reported.quality, 'rttMs'),
              lossRatio: statNumber(reported.quality, 'lossRatio'),
              transport: statString(reported.quality, 'transport'),
            }
          : null,
      };
    }),
    nextCursor: hasMore && last ? last.id : null,
    hasMore,
  };
}

export interface CallStats {
  total: number;
  answered: number;
  missed: number;
  failed: number;
  /** Answered calls only — a declined call has no meaningful duration. */
  totalMinutes: number;
  averageDurationSec: number;
  byKind: Array<{ kind: CallKind; count: number }>;
  last7Days: Array<{ date: string; calls: number }>;
  /** Share of answered calls that had to fall back to a TURN relay. */
  relayShare: number | null;
}

export async function callStats(): Promise<CallStats> {
  const since = startOfDayUtc(6);

  const [total, answered, missed, failed, durations, byKind, recent, relayed] = await Promise.all([
    db.call.count(),
    db.call.count({ where: { answeredAt: { not: null } } }),
    db.call.count({ where: { status: 'MISSED' } }),
    db.call.count({ where: { status: 'FAILED' } }),
    db.call.aggregate({ where: { durationSec: { not: null } }, _sum: { durationSec: true } }),
    db.call.groupBy({ by: ['kind'], _count: { _all: true } }),
    db.call.findMany({ where: { startedAt: { gte: since } }, select: { startedAt: true } }),
    db.callParticipant.findMany({
      where: { quality: { not: Prisma.DbNull } },
      select: { quality: true },
      take: 500,
      orderBy: { id: 'desc' },
    }),
  ]);

  const totalSeconds = durations._sum.durationSec ?? 0;
  const transports = relayed.map((row) => statString(row.quality, 'transport'));
  const known = transports.filter((value) => value === 'relay' || value === 'direct');

  return {
    total,
    answered,
    missed,
    failed,
    totalMinutes: Math.round(totalSeconds / 60),
    averageDurationSec: answered > 0 ? Math.round(totalSeconds / answered) : 0,
    byKind: byKind.map((row) => ({ kind: row.kind, count: row._count._all })),
    last7Days: bucketByDay(
      recent.map((row) => row.startedAt),
      since,
      7,
    ).map(([date, calls]) => ({ date, calls })),
    relayShare:
      known.length > 0 ? known.filter((value) => value === 'relay').length / known.length : null,
  };
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  action: AuditAction;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
}

export async function listAuditLogs(input: {
  cursor?: string | null;
  limit?: number;
  action?: AuditAction;
}): Promise<Page<AuditLogRow>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const rows = await db.auditLog.findMany({
    where: input.action ? { action: input.action } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => ({
      id: row.id,
      userId: row.userId,
      action: row.action,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? last.id : null,
    hasMore,
  };
}

export interface SystemHealth {
  status: 'healthy' | 'degraded';
  uptimeSeconds: number;
  nodeVersion: string;
  environment: string;
  database: { ok: boolean; latencyMs: number; error?: string };
  socket: { connections: number; onlineUsers: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
}

export async function systemHealth(): Promise<SystemHealth> {
  const database = await checkDatabaseHealth();
  const memory = process.memoryUsage();
  const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

  return {
    status: database.ok ? 'healthy' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    environment: serverEnv().NODE_ENV,
    database,
    socket: { connections: connectionCount(), onlineUsers: onlineUserIds().length },
    memory: {
      rssMb: toMb(memory.rss),
      heapUsedMb: toMb(memory.heapUsed),
      heapTotalMb: toMb(memory.heapTotal),
    },
  };
}

export interface AdminOverview {
  users: number;
  messages: number;
  attachments: number;
  calls: number;
  ephemeralPending: number;
  ephemeralPurged: number;
  storage: Awaited<ReturnType<typeof storageUsage>>;
  activity: Array<{ date: string; messages: number }>;
  health: SystemHealth;
}

/** Everything the dashboard needs in one round trip. */
export async function adminOverview(): Promise<AdminOverview> {
  const since = startOfDayUtc(13);

  const [
    users,
    messages,
    attachments,
    calls,
    ephemeralPending,
    ephemeralPurged,
    storage,
    health,
    recent,
  ] = await Promise.all([
    db.user.count(),
    db.message.count(),
    db.attachment.count({ where: { purgedAt: null } }),
    db.call.count(),
    db.message.count({ where: { ephemeralMode: { not: 'NORMAL' }, purgedAt: null } }),
    db.message.count({ where: { purgedAt: { not: null } } }),
    storageUsage(),
    systemHealth(),
    db.message.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
    }),
  ]);

  const buckets = bucketByDay(
    recent.map((row) => row.createdAt),
    since,
    14,
  );

  return {
    users,
    messages,
    attachments,
    calls,
    ephemeralPending,
    ephemeralPurged,
    storage,
    activity: buckets.map(([date, count]) => ({ date, messages: count })),
    health,
  };
}

// ---------------------------------------------------------------------------
// Uploads, database, analytics
// ---------------------------------------------------------------------------

export interface UploadStats {
  total: number;
  totalBytes: number;
  averageBytes: number;
  largestBytes: number;
  /** Uploads whose blob has been destroyed by the ephemeral purge. */
  purged: number;
  /** Attached to a message that is itself disappearing. */
  ephemeral: number;
  /** Never attached to a message; reclaimable. */
  orphaned: number;
  byKind: Array<{ kind: AttachmentKind; count: number; bytes: number }>;
  byProvider: Array<{ provider: string; count: number; bytes: number }>;
  byUploader: Array<{ userId: string; email: string; count: number; bytes: number }>;
  last14Days: Array<{ date: string; uploads: number }>;
}

/**
 * Upload statistics.
 *
 * Counts and byte totals only — this reads the attachment metadata, never the
 * objects themselves, so it says nothing about what any file contains.
 */
export async function uploadStats(): Promise<UploadStats> {
  const since = startOfDayUtc(13);

  const [
    aggregate,
    largest,
    purged,
    ephemeral,
    orphaned,
    byKind,
    byProvider,
    byUploader,
    recent,
    users,
  ] = await Promise.all([
    db.attachment.aggregate({ _count: { _all: true }, _sum: { byteSize: true } }),
    db.attachment.aggregate({ _max: { byteSize: true } }),
    db.attachment.count({ where: { purgedAt: { not: null } } }),
    db.attachment.count({ where: { message: { is: { ephemeralMode: { not: 'NORMAL' } } } } }),
    db.attachment.count({ where: { messageId: null, purgedAt: null } }),
    db.attachment.groupBy({ by: ['kind'], _count: { _all: true }, _sum: { byteSize: true } }),
    db.attachment.groupBy({ by: ['provider'], _count: { _all: true }, _sum: { byteSize: true } }),
    db.attachment.groupBy({ by: ['uploaderId'], _count: { _all: true }, _sum: { byteSize: true } }),
    db.attachment.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    db.user.findMany({ select: { id: true, email: true } }),
  ]);

  const emailById = new Map(users.map((user) => [user.id, user.email]));
  const total = aggregate._count._all;
  const totalBytes = aggregate._sum.byteSize ?? 0;

  return {
    total,
    totalBytes,
    averageBytes: total > 0 ? Math.round(totalBytes / total) : 0,
    largestBytes: largest._max.byteSize ?? 0,
    purged,
    ephemeral,
    orphaned,
    byKind: byKind.map((row) => ({
      kind: row.kind,
      count: row._count._all,
      bytes: row._sum.byteSize ?? 0,
    })),
    byProvider: byProvider.map((row) => ({
      provider: row.provider,
      count: row._count._all,
      bytes: row._sum.byteSize ?? 0,
    })),
    byUploader: byUploader.map((row) => ({
      userId: row.uploaderId,
      email: emailById.get(row.uploaderId) ?? 'unknown',
      count: row._count._all,
      bytes: row._sum.byteSize ?? 0,
    })),
    last14Days: bucketByDay(
      recent.map((row) => row.createdAt),
      since,
      14,
    ).map(([date, uploads]) => ({ date, uploads })),
  };
}

export interface DatabaseStatus {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Server version string, when the engine will tell us. */
  version: string | null;
  /** On-disk size in bytes. Null on engines without the introspection. */
  sizeBytes: number | null;
  tables: Array<{ table: string; rows: number }>;
}

export async function databaseStatus(): Promise<DatabaseStatus> {
  const health = await checkDatabaseHealth();

  if (!health.ok) {
    return { ...health, version: null, sizeBytes: null, tables: [] };
  }

  const [
    users,
    sessions,
    devices,
    chats,
    messages,
    attachments,
    reactions,
    receipts,
    calls,
    notifications,
    auditLogs,
    errorLogs,
    rateLimitBuckets,
  ] = await Promise.all([
    db.user.count(),
    db.session.count(),
    db.device.count(),
    db.chat.count(),
    db.message.count(),
    db.attachment.count(),
    db.reaction.count(),
    db.receipt.count(),
    db.call.count(),
    db.notification.count(),
    db.auditLog.count(),
    db.errorLog.count(),
    db.rateLimitBucket.count(),
  ]);

  // Introspection is PostgreSQL-specific and non-essential; a failure here must
  // not turn a healthy database into a red panel.
  let version: string | null = null;
  let sizeBytes: number | null = null;
  try {
    const rows = await db.$queryRaw<Array<{ version: string; size: bigint }>>`
      SELECT version() AS version, pg_database_size(current_database()) AS size
    `;
    const row = rows[0];
    if (row) {
      version = row.version.split(' ').slice(0, 2).join(' ');
      sizeBytes = Number(row.size);
    }
  } catch {
    // Left null; the row counts above are the part that matters.
  }

  return {
    ...health,
    version,
    sizeBytes,
    tables: [
      { table: 'users', rows: users },
      { table: 'sessions', rows: sessions },
      { table: 'devices', rows: devices },
      { table: 'chats', rows: chats },
      { table: 'messages', rows: messages },
      { table: 'attachments', rows: attachments },
      { table: 'reactions', rows: reactions },
      { table: 'receipts', rows: receipts },
      { table: 'calls', rows: calls },
      { table: 'notifications', rows: notifications },
      { table: 'audit_logs', rows: auditLogs },
      { table: 'error_logs', rows: errorLogs },
      { table: 'rate_limit_buckets', rows: rateLimitBuckets },
    ],
  };
}

export interface SystemAnalytics {
  /** Fourteen days of every stream that produces rows, on one axis. */
  series: Array<{ date: string; messages: number; calls: number; uploads: number }>;
  messagesByType: Array<{ type: string; count: number }>;
  /** UTC hour-of-day histogram over the same window. */
  byHour: Array<{ hour: number; messages: number }>;
  perUser: Array<{ userId: string; email: string; messages: number; attachments: number }>;
  totals: {
    messages: number;
    messagesLast14Days: number;
    reactions: number;
    edited: number;
    deleted: number;
    ephemeral: number;
    /** Messages hidden by the disappearing-mode watermark, not deleted. */
    hidden: number;
  };
  calls: CallStats;
}

/** The analytics pane: fourteen days of activity, and how it splits. */
export async function systemAnalytics(): Promise<SystemAnalytics> {
  const since = startOfDayUtc(13);

  const [
    messageRows,
    callRows,
    uploadRows,
    messagesByType,
    users,
    perUserMessages,
    perUserAttachments,
    totals,
    calls,
  ] = await Promise.all([
    db.message.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
    }),
    db.call.findMany({ where: { startedAt: { gte: since } }, select: { startedAt: true } }),
    db.attachment.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    db.message.groupBy({ by: ['type'], _count: { _all: true } }),
    db.user.findMany({ select: { id: true, email: true } }),
    db.message.groupBy({ by: ['authorId'], _count: { _all: true } }),
    db.attachment.groupBy({ by: ['uploaderId'], _count: { _all: true } }),
    Promise.all([
      db.message.count(),
      db.reaction.count(),
      db.message.count({ where: { editedAt: { not: null } } }),
      db.message.count({ where: { deletedForAll: true } }),
      db.message.count({ where: { ephemeralMode: { not: 'NORMAL' } } }),
      hiddenMessageCount(),
    ]),
    callStats(),
  ]);

  const emailById = new Map(users.map((user) => [user.id, user.email]));
  const messageDays = bucketByDay(
    messageRows.map((row) => row.createdAt),
    since,
    14,
  );
  const callDays = new Map(
    bucketByDay(
      callRows.map((row) => row.startedAt),
      since,
      14,
    ),
  );
  const uploadDays = new Map(
    bucketByDay(
      uploadRows.map((row) => row.createdAt),
      since,
      14,
    ),
  );

  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of messageRows) {
    const hour = row.createdAt.getUTCHours();
    hours[hour] = (hours[hour] ?? 0) + 1;
  }

  const attachmentsByUser = new Map(
    perUserAttachments.map((row) => [row.uploaderId, row._count._all]),
  );

  const [messages, reactions, edited, deleted, ephemeral, hidden] = totals;

  return {
    series: messageDays.map(([date, count]) => ({
      date,
      messages: count,
      calls: callDays.get(date) ?? 0,
      uploads: uploadDays.get(date) ?? 0,
    })),
    messagesByType: messagesByType.map((row) => ({ type: row.type, count: row._count._all })),
    byHour: hours.map((count, hour) => ({ hour, messages: count })),
    perUser: perUserMessages
      .map((row) => ({
        userId: row.authorId,
        email: emailById.get(row.authorId) ?? 'unknown',
        messages: row._count._all,
        attachments: attachmentsByUser.get(row.authorId) ?? 0,
      }))
      .sort((a, b) => b.messages - a.messages),
    totals: {
      messages,
      messagesLast14Days: messageRows.length,
      reactions,
      edited,
      deleted,
      ephemeral,
      hidden,
    },
    calls,
  };
}

/**
 * How many messages the disappearing-mode watermark is currently withholding.
 *
 * Reported so the operator can see the cost of the switch without the switch
 * having destroyed anything: these rows are all still there.
 */
async function hiddenMessageCount(): Promise<number> {
  const settings = await db.appSetting.findUnique({
    where: { id: 'global' },
    select: { messagesHiddenBefore: true },
  });
  if (!settings?.messagesHiddenBefore) return 0;
  return db.message.count({ where: { createdAt: { lt: settings.messagesHiddenBefore } } });
}
