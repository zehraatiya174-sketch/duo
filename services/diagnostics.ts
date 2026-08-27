import type { ErrorSeverity, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import type { Page } from '@/types/models';

/**
 * The server-side error log.
 *
 * `AuditLog` records what people did on purpose; this records what went wrong.
 * Keeping the two apart matters when reading either: a page of failed uploads
 * should not be buried under a page of successful sign-ins.
 *
 * Writes here are best-effort by construction — see `recordError`. A logging
 * table that can take the request down with it is worse than no table.
 */

/** How much of a stack is worth keeping. Beyond this it is all framework. */
const MAX_STACK_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 1_000;

export interface ErrorLogRow {
  id: string;
  severity: ErrorSeverity;
  scope: string;
  message: string;
  stack: string | null;
  context: unknown;
  createdAt: string;
}

export interface RecordErrorInput {
  severity: ErrorSeverity;
  scope: string;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown>;
}

/**
 * Persists one fault.
 *
 * Never throws and never awaited by the caller: if the database is the thing
 * that is broken, the attempt to write about it must not become a second
 * failure on top of the first.
 */
export async function recordError(input: RecordErrorInput): Promise<void> {
  try {
    await db.errorLog.create({
      data: {
        severity: input.severity,
        scope: input.scope.slice(0, 120),
        message: input.message.slice(0, MAX_MESSAGE_CHARS),
        stack: input.stack ? input.stack.slice(0, MAX_STACK_CHARS) : null,
        // Already redacted by the logger; cast because Prisma's JSON input type
        // cannot describe "any plain object" without one.
        ...(input.context === undefined
          ? {}
          : { context: input.context as Prisma.InputJsonValue }),
      },
    });
  } catch {
    // Swallowed on purpose. The console sink has already emitted the same line.
  }
}

export interface ErrorLogFilter {
  cursor?: string | null;
  limit?: number;
  severity?: ErrorSeverity;
  scope?: string;
}

export async function listErrorLogs(input: ErrorLogFilter): Promise<Page<ErrorLogRow>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const where: Prisma.ErrorLogWhereInput = {
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.scope ? { scope: { contains: input.scope, mode: 'insensitive' } } : {}),
  };

  const rows = await db.errorLog.findMany({
    where,
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
      severity: row.severity,
      scope: row.scope,
      message: row.message,
      stack: row.stack,
      context: row.context,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? last.id : null,
    hasMore,
  };
}

export interface ErrorSummary {
  total: number;
  last24h: number;
  bySeverity: Array<{ severity: ErrorSeverity; count: number }>;
  /** The noisiest scopes in the last day — where to look first. */
  topScopes: Array<{ scope: string; count: number }>;
  latestAt: string | null;
}

export async function errorSummary(): Promise<ErrorSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, last24h, bySeverity, topScopes, latest] = await Promise.all([
    db.errorLog.count(),
    db.errorLog.count({ where: { createdAt: { gte: since } } }),
    db.errorLog.groupBy({ by: ['severity'], _count: { _all: true } }),
    db.errorLog.groupBy({
      by: ['scope'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { scope: 'desc' } },
      take: 5,
    }),
    db.errorLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);

  return {
    total,
    last24h,
    bySeverity: bySeverity.map((row) => ({ severity: row.severity, count: row._count._all })),
    topScopes: topScopes.map((row) => ({ scope: row.scope, count: row._count._all })),
    latestAt: latest?.createdAt.toISOString() ?? null,
  };
}

/**
 * Drops entries older than the retention window. Called by the maintenance
 * sweep; this is diagnostic noise, not user data.
 */
export async function pruneErrorLogs(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await db.errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
