import { db } from './db';
import { serverEnv } from './env';
import { rateLimited } from './errors';
import { createLogger } from './logger';

const log = createLogger('rate-limit');

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Unix milliseconds at which the current window resets. */
  resetAt: number;
  retryAfterSeconds: number;
}

/**
 * Named policies. Kept in one place so limits are auditable rather than
 * scattered as magic numbers across route handlers.
 */
export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  register: { limit: 4, windowSeconds: 3600 },
  passwordReset: { limit: 4, windowSeconds: 3600 },
  /// The post-login passphrase. Short phrases only stay secret if guessing them
  /// is slow, so this is among the tightest limits in the table — 40 attempts an
  /// hour, against an attacker who already holds a valid session.
  verification: { limit: 10, windowSeconds: 900 },
  sendMessage: { limit: 90, windowSeconds: 60 },
  editMessage: { limit: 40, windowSeconds: 60 },
  reaction: { limit: 120, windowSeconds: 60 },
  /// Opening disappearing content is inherently low-frequency; a burst is a
  /// sign of automated harvesting rather than a person tapping a bubble.
  ephemeralOpen: { limit: 30, windowSeconds: 60 },
  /// Settling a look is bookkeeping, not access: each open produces two or
  /// three of these, and throttling them would strand reservations that the
  /// lease sweep then has to clean up. Deliberately looser than the open limit.
  ephemeralSettle: { limit: 120, windowSeconds: 60 },
  upload: { limit: 40, windowSeconds: 300 },
  mediaRead: { limit: 600, windowSeconds: 60 },
  search: { limit: 60, windowSeconds: 60 },
  linkPreview: { limit: 30, windowSeconds: 300 },
  profileUpdate: { limit: 20, windowSeconds: 3600 },
  callStart: { limit: 20, windowSeconds: 300 },
  socketEvent: { limit: 400, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * L1 in-process cache. Absorbs the overwhelming majority of checks without a
 * round trip; the database row (L2) is what survives a restart and what makes
 * the limit correct across multiple processes.
 */
const memory = new Map<string, Bucket>();
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
const MAX_MEMORY_KEYS = 20_000;

function sweep(): void {
  const now = Date.now();
  for (const [key, bucket] of memory) {
    if (bucket.resetAt <= now) memory.delete(key);
  }
  // Hard cap as a defence against key-space flooding.
  if (memory.size > MAX_MEMORY_KEYS) {
    const excess = memory.size - MAX_MEMORY_KEYS;
    let removed = 0;
    for (const key of memory.keys()) {
      memory.delete(key);
      if (++removed >= excess) break;
    }
  }
}

if (typeof setInterval === 'function') {
  const timer = setInterval(sweep, MEMORY_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

function bucketKey(name: RateLimitName, identifier: string): string {
  return `${name}:${identifier}`;
}

/**
 * Fixed-window counter. Checked in-memory first, then persisted so that limits
 * survive restarts and hold across a horizontally scaled deployment.
 */
export async function checkRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];

  if (!serverEnv().RATE_LIMIT_ENABLED) {
    return {
      allowed: true,
      remaining: rule.limit,
      limit: rule.limit,
      resetAt: Date.now() + rule.windowSeconds * 1000,
      retryAfterSeconds: 0,
    };
  }

  const key = bucketKey(name, identifier);
  const now = Date.now();
  const cached = memory.get(key);

  // Fast path: already over the limit inside a live window.
  if (cached && cached.resetAt > now && cached.count >= rule.limit) {
    return {
      allowed: false,
      remaining: 0,
      limit: rule.limit,
      resetAt: cached.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((cached.resetAt - now) / 1000)),
    };
  }

  const windowEnd =
    cached && cached.resetAt > now ? cached.resetAt : now + rule.windowSeconds * 1000;

  let count: number;
  try {
    const row = await db.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date(windowEnd) },
      update: {},
      select: { count: true, expiresAt: true },
    });

    if (row.expiresAt.getTime() <= now) {
      // Stale window — reset it.
      const reset = await db.rateLimitBucket.update({
        where: { key },
        data: { count: 1, expiresAt: new Date(now + rule.windowSeconds * 1000) },
        select: { count: true, expiresAt: true },
      });
      count = reset.count;
      memory.set(key, { count, resetAt: reset.expiresAt.getTime() });
      return {
        allowed: true,
        remaining: rule.limit - count,
        limit: rule.limit,
        resetAt: reset.expiresAt.getTime(),
        retryAfterSeconds: 0,
      };
    }

    if (row.count === 1 && !cached) {
      // The upsert created the row; that is our first hit.
      count = 1;
    } else {
      const incremented = await db.rateLimitBucket.update({
        where: { key },
        data: { count: { increment: 1 } },
        select: { count: true },
      });
      count = incremented.count;
    }

    memory.set(key, { count, resetAt: row.expiresAt.getTime() });

    const allowed = count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - count),
      limit: rule.limit,
      resetAt: row.expiresAt.getTime(),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((row.expiresAt.getTime() - now) / 1000)),
    };
  } catch (error) {
    // Never let a limiter outage take the whole app down: degrade to the
    // in-memory counter, which is still a meaningful defence per process.
    log.warn('Persistent rate limit unavailable, falling back to memory', { error, key });
    const bucket =
      cached && cached.resetAt > now
        ? cached
        : { count: 0, resetAt: now + rule.windowSeconds * 1000 };
    bucket.count += 1;
    memory.set(key, bucket);
    const allowed = bucket.count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - bucket.count),
      limit: rule.limit,
      resetAt: bucket.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
}

/** Throws a 429 AppError when the caller is over budget. */
export async function enforceRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const result = await checkRateLimit(name, identifier);
  if (!result.allowed) {
    throw rateLimited(
      result.retryAfterSeconds,
      `Rate limit exceeded. Try again in ${result.retryAfterSeconds}s.`,
    );
  }
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
  };
  if (!result.allowed) headers['Retry-After'] = String(result.retryAfterSeconds);
  return headers;
}

/** Removes expired persisted buckets. Invoked by the maintenance job. */
export async function pruneRateLimitBuckets(): Promise<number> {
  const { count } = await db.rateLimitBucket.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

/** Test-only hook so suites do not leak counters between cases. */
export function __resetRateLimitMemory(): void {
  memory.clear();
}
