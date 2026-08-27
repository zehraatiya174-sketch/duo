import { PrismaClient } from '@prisma/client';

import { isDevelopment, isProduction } from '@/lib/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('db');

/**
 * The Prisma client is a connection pool, not a value — creating a second one
 * doubles the pool. In development `tsx watch` re-evaluates this module on every
 * save, so the instance is parked on `globalThis` and reused across reloads.
 * Without this a long editing session exhausts Postgres' connection limit.
 */
const globalForPrisma = globalThis as unknown as {
  duoPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  return new PrismaClient({
    // Queries are noisy and can contain message bodies; they stay off outside
    // development, where `warn` and `error` are still worth surfacing.
    log: isDevelopment
      ? [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [{ emit: 'stdout', level: 'error' }],
    errorFormat: isProduction ? 'minimal' : 'pretty',
  });
}

export const db: PrismaClient = globalForPrisma.duoPrisma ?? createClient();

if (!isProduction) globalForPrisma.duoPrisma = db;

export interface DatabaseHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * A cheap round-trip used by `/api/health` and the admin dashboard.
 *
 * Never throws: a managed Postgres that is still waking up should render as a
 * degraded state, not crash the process at boot. The latency is reported even
 * on failure so a timeout is distinguishable from a refused connection.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const startedAt = performance.now();

  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    log.error('Health check failed', { error: message });
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: message,
    };
  }
}

/**
 * Closes the pool. Called from the server's shutdown path so in-flight queries
 * finish before the process exits and Postgres is not left with dangling
 * connections after a redeploy.
 */
export async function disconnectDatabase(): Promise<void> {
  await db.$disconnect();
}
