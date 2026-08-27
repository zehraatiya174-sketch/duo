import { NextResponse } from 'next/server';

import { checkDatabaseHealth } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HealthBody {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  database: { ok: boolean; latencyMs: number };
}

/**
 * The platform's liveness probe. Public and unauthenticated by design —
 * Render, Railway and Fly all call it without cookies.
 *
 * Answers 503 while the database is unreachable so a deploy that comes up
 * without its database is held back rather than routed to. Nothing identifying
 * is returned: an unauthenticated endpoint must not disclose who is online, how
 * many messages exist, or the database's error text.
 */
export async function GET(): Promise<NextResponse<HealthBody>> {
  const database = await checkDatabaseHealth();

  return NextResponse.json<HealthBody>(
    {
      status: database.ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: { ok: database.ok, latencyMs: database.latencyMs },
    },
    {
      status: database.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
