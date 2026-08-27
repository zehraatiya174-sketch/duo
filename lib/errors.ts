import { ZodError } from 'zod';

/**
 * Application error taxonomy. Every thrown AppError maps to exactly one HTTP
 * status and one stable machine-readable code, so the client can branch on
 * `code` without string-matching messages.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'NOT_AUTHORIZED_ACCOUNT'
  | 'VERIFICATION_REQUIRED'
  | 'EPHEMERAL_EXHAUSTED'
  | 'EPHEMERAL_EXPIRED'
  | 'STORAGE_FAILED'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  NOT_AUTHORIZED_ACCOUNT: 403,
  /// Signed in, but the second gate has not been cleared. Distinct from
  /// FORBIDDEN so the client can redirect to /verify instead of showing a wall.
  VERIFICATION_REQUIRED: 403,
  EPHEMERAL_EXHAUSTED: 410,
  EPHEMERAL_EXPIRED: 410,
  STORAGE_FAILED: 502,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** Field-level details, safe to show to the user. */
  details?: Record<string, string[]>;
  /** Seconds until the caller may retry. Sent as Retry-After for 429/503. */
  retryAfter?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, string[]>;
  readonly retryAfter?: number;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, string[]> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Runtime view of the `ErrorCode` union, so the browser client can validate a
 * code coming back over the wire without duplicating the list.
 */
export const ERROR_CODES = Object.keys(STATUS_BY_CODE) as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  // `hasOwn`, not `in`: the latter walks the prototype chain, so a response
  // body claiming `code: "toString"` would pass for a real code.
  return typeof value === 'string' && Object.hasOwn(STATUS_BY_CODE, value);
}

export const badRequest = (message = 'Malformed request', o?: AppErrorOptions) =>
  new AppError('BAD_REQUEST', message, o);
export const unauthorized = (message = 'You must be signed in', o?: AppErrorOptions) =>
  new AppError('UNAUTHORIZED', message, o);
export const forbidden = (
  message = 'You do not have access to this resource',
  o?: AppErrorOptions,
) => new AppError('FORBIDDEN', message, o);
export const notFound = (message = 'Not found', o?: AppErrorOptions) =>
  new AppError('NOT_FOUND', message, o);
export const conflict = (message = 'Conflicts with existing state', o?: AppErrorOptions) =>
  new AppError('CONFLICT', message, o);
export const rateLimited = (retryAfter: number, message = 'Too many requests') =>
  new AppError('RATE_LIMITED', message, { retryAfter });
export const internal = (message = 'Something went wrong', o?: AppErrorOptions) =>
  new AppError('INTERNAL', message, o);

/** Converts a ZodError into a flat `field -> messages` map. */
export function zodToDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export function fromZodError(error: ZodError, message = 'Validation failed'): AppError {
  return new AppError('VALIDATION_FAILED', message, { details: zodToDetails(error) });
}

/**
 * Normalises any thrown value into an AppError. Unknown errors collapse to a
 * generic INTERNAL so implementation details never leak to the client.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return fromZodError(error);
  if (error instanceof Error) {
    return new AppError('INTERNAL', 'Something went wrong', { cause: error });
  }
  return new AppError('INTERNAL', 'Something went wrong', { cause: error });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
