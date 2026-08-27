/**
 * Custom Node entry point.
 *
 * Next.js and Socket.IO share a single HTTP server here. A persistent socket
 * server cannot live in a serverless function, so hosting both in one process
 * is what makes sub-100ms delivery possible on a single Railway/Fly/VPS dyno.
 * For a split deployment (Next on Vercel, this file on Railway) point
 * `NEXT_PUBLIC_SOCKET_URL` at the socket host and everything else still works.
 *
 * Environment is loaded *before* any other import: `lib/env.ts` validates on
 * module evaluation, so a static import would run before `.env` was read.
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

async function main(): Promise<void> {
  const { createServer } = await import('node:http');
  const { parse } = await import('node:url');

  const next = (await import('next')).default;

  // `@/lib/env` is deliberately the only application module imported above
  // `app.prepare()`: it is plain schema validation and pulls in nothing else.
  const { serverEnv } = await import('@/lib/env');

  const env = serverEnv();
  const dev = env.NODE_ENV !== 'production';

  const app = next({ dev, hostname: '0.0.0.0', port: env.PORT });
  const handle = app.getRequestHandler();

  await app.prepare();

  // ---------------------------------------------------------------------------
  // Everything below this line, and nothing above it.
  //
  // `app.prepare()` is what installs `globalThis.AsyncLocalStorage`. Anything
  // reaching `next/headers` before that point makes Next cache a non-functional
  // storage instance for the lifetime of the process, and *every* subsequent
  // request then fails with "AsyncLocalStorage accessed in runtime where it is
  // not available" — while the server still logs a healthy start, so the only
  // symptom is a total outage that looks like a working boot.
  //
  // The route is not obvious: `@/socket/server` → `socket/auth` →
  // `@/lib/auth/verification` → `next/headers`. Any new import here can
  // reintroduce it, so add them below, never above.
  // ---------------------------------------------------------------------------
  const { createLogger } = await import('@/lib/logger');
  const { checkDatabaseHealth, db } = await import('@/lib/db');
  const { createSocketServer } = await import('@/socket/server');
  const { ensureDuoChat } = await import('@/services/provisioning');

  const log = createLogger('server');

  const httpServer = createServer((req, res) => {
    try {
      // `parse` with query parsing is what Next's own examples use; its route
      // matcher expects the parsed shape rather than a raw URL string.
      handle(req, res, parse(req.url ?? '/', true)).catch((error: unknown) => {
        log.error('Request handler failed', { error, url: req.url });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        }
      });
    } catch (error) {
      log.error('Request threw synchronously', { error, url: req.url });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  });

  // Long-lived uploads and slow mobile networks need more than Node's 5s default
  // before the socket is torn down mid-request.
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.requestTimeout = 300_000;

  const { shutdown: shutdownSockets } = createSocketServer(httpServer);

  const health = await checkDatabaseHealth();
  if (!health.ok) {
    // Not fatal: the app should still boot and show a degraded state rather than
    // crash-loop while a managed Postgres instance is waking up.
    log.error('Database is not reachable at boot', { error: health.error });
  } else {
    await ensureDuoChat().catch((error: unknown) =>
      log.error('Failed to provision the conversation', { error }),
    );
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(env.PORT, () => resolve());
  });

  log.info('Server ready', {
    url: `http://localhost:${env.PORT}`,
    socketPath: env.SOCKET_PATH,
    mode: dev ? 'development' : 'production',
    database: health.ok ? 'connected' : 'unreachable',
  });

  // --- graceful shutdown ---------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });

    const force = setTimeout(() => {
      log.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    force.unref();

    void (async () => {
      try {
        await shutdownSockets();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await app.close();
        await db.$disconnect();
        clearTimeout(force);
        log.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        log.error('Shutdown failed', { error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { error });
    shutdown('uncaughtException');
  });
}

void main().catch((error: unknown) => {
  console.error('[server] Fatal startup error:', error);
  process.exit(1);
});
