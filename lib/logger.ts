/* eslint-disable no-console */
// Deliberately `./env.client`, not `./env`. These two flags are only
// re-exported by the server module, but importing them from there drags the
// entire server schema — every secret's variable name and validation rule —
// into any client bundle that logs. The logger runs on both sides by design
// (see the `typeof window` guard below), so it must depend on the public half.
import { isDevelopment, isTest } from './env.client';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel = isTest ? 'error' : isDevelopment ? 'debug' : 'info';

/** Keys whose values must never reach a log sink. */
const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'sessionToken',
  'encryptionIv',
  'encryptionTag',
]);

export type LogContext = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Mirrors warnings and errors into the database so the admin console has an
 * error log to read.
 *
 * Guarded three ways: the browser has no `db`, a test run should not open a
 * connection to say something failed, and the persistence path itself is
 * excluded so a database fault cannot recurse into another write. The import is
 * dynamic so a client component importing the logger does not drag Prisma with
 * it, and the promise is deliberately not awaited — the request has already been
 * answered by the time this lands.
 */
const NEVER_PERSISTED = new Set(['diagnostics', 'db', 'prisma']);

function persist(level: LogLevel, scope: string, message: string, context?: LogContext): void {
  if (level !== 'error' && level !== 'warn') return;
  if (isTest || typeof window !== 'undefined') return;
  if (NEVER_PERSISTED.has(scope.split(':')[0] ?? scope)) return;

  void import('@/services/diagnostics')
    .then(({ recordError }) => {
      const error = context?.['error'];
      return recordError({
        severity: level === 'error' ? 'ERROR' : 'WARN',
        scope,
        message,
        stack: error instanceof Error ? (error.stack ?? null) : null,
        ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
      });
    })
    .catch(() => {
      // Already reported to the console sink; nothing further to do.
    });
}

function emit(level: LogLevel, scope: string, message: string, context?: LogContext): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context ? { context: redact(context) as LogContext } : {}),
  };

  persist(level, scope, message, context);

  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;

  if (isDevelopment) {
    const tint = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[
      level
    ];
    sink(
      `${tint}[${level}]\x1b[0m \x1b[1m${scope}\x1b[0m ${message}`,
      context ? redact(context) : '',
    );
    return;
  }

  sink(JSON.stringify(payload));
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, context) => emit('debug', scope, message, context),
    info: (message, context) => emit('info', scope, message, context),
    warn: (message, context) => emit('warn', scope, message, context),
    error: (message, context) => emit('error', scope, message, context),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export const logger = createLogger('app');
