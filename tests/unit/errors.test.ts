import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  ERROR_CODES,
  badRequest,
  conflict,
  forbidden,
  fromZodError,
  internal,
  isAppError,
  isErrorCode,
  notFound,
  rateLimited,
  toAppError,
  unauthorized,
  zodToDetails,
} from '@/lib/errors';

/**
 * The error taxonomy is the contract between the route handlers and the browser
 * client: the client branches on `code`, so a code that maps to the wrong
 * status — or an internal detail that survives normalisation — is a real bug.
 */

describe('status mapping', () => {
  const expected: Record<string, number> = {
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
    VERIFICATION_REQUIRED: 403,
    EPHEMERAL_EXHAUSTED: 410,
    EPHEMERAL_EXPIRED: 410,
    STORAGE_FAILED: 502,
    INTERNAL: 500,
  };

  it('gives every code the status the client expects', () => {
    for (const [code, status] of Object.entries(expected)) {
      expect(new AppError(code as never, 'x').status, code).toBe(status);
    }
  });

  it('exposes the whole union at runtime with nothing extra', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(expected).sort());
  });

  /** A spent view-once is a 410, not a 404: the difference is user-visible. */
  it('separates the two ephemeral failures while sharing a status', () => {
    expect(new AppError('EPHEMERAL_EXHAUSTED', 'x').status).toBe(410);
    expect(new AppError('EPHEMERAL_EXPIRED', 'x').status).toBe(410);
    expect(new AppError('EPHEMERAL_EXHAUSTED', 'x').code).not.toBe(
      new AppError('EPHEMERAL_EXPIRED', 'x').code,
    );
  });
});

describe('AppError', () => {
  it('is a real Error, so it survives throw/catch and instanceof', () => {
    const error = new AppError('NOT_FOUND', 'Message not found');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.message).toBe('Message not found');
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
  });

  it('carries optional details, retryAfter and cause', () => {
    const cause = new Error('root');
    const error = new AppError('RATE_LIMITED', 'Slow down', {
      details: { email: ['Required'] },
      retryAfter: 30,
      cause,
    });

    expect(error.details).toEqual({ email: ['Required'] });
    expect(error.retryAfter).toBe(30);
    expect(error.cause).toBe(cause);
  });

  it('leaves details and retryAfter undefined when not supplied', () => {
    const error = new AppError('NOT_FOUND', 'x');
    expect(error.details).toBeUndefined();
    expect(error.retryAfter).toBeUndefined();
  });
});

describe('toJSON', () => {
  it('emits the wire shape the client parses', () => {
    expect(new AppError('CONFLICT', 'Already exists').toJSON()).toEqual({
      error: { code: 'CONFLICT', message: 'Already exists' },
    });
  });

  it('omits the details key entirely when there are none', () => {
    expect(Object.keys(new AppError('NOT_FOUND', 'x').toJSON().error)).toEqual(['code', 'message']);
  });

  /** `cause` and `retryAfter` are server business; only the header carries the latter. */
  it('never serialises the cause or the stack', () => {
    const error = new AppError('INTERNAL', 'Something went wrong', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      retryAfter: 5,
    });

    const serialised = JSON.stringify(error.toJSON());
    expect(serialised).not.toContain('5432');
    expect(serialised).not.toContain('stack');
    expect(serialised).not.toContain('retryAfter');
  });

  it('round-trips through JSON.stringify on the error itself', () => {
    const body = JSON.parse(JSON.stringify(new AppError('GONE', 'Expired'))) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('GONE');
  });
});

describe('constructors', () => {
  it('produce the right code with a sensible default message', () => {
    expect(badRequest()).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(unauthorized()).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(forbidden()).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(notFound()).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(conflict()).toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(internal()).toMatchObject({ code: 'INTERNAL', status: 500 });

    for (const error of [
      badRequest(),
      unauthorized(),
      forbidden(),
      notFound(),
      conflict(),
      internal(),
    ]) {
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('accepts an override message', () => {
    expect(notFound('No such chat').message).toBe('No such chat');
  });

  it('makes retryAfter mandatory for a rate limit', () => {
    expect(rateLimited(15)).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfter: 15 });
  });
});

describe('zodToDetails', () => {
  const schema = z.object({
    email: z.string().email('Enter a valid email'),
    profile: z.object({ bio: z.string().max(2, 'Too long') }),
  });

  it('keys the map by the dotted field path', () => {
    const result = schema.safeParse({ email: 'nope', profile: { bio: 'far too long' } });
    const details = zodToDetails(result.success ? new z.ZodError([]) : result.error);

    expect(details).toEqual({
      email: ['Enter a valid email'],
      'profile.bio': ['Too long'],
    });
  });

  it('collects several issues for one field', () => {
    const strict = z.object({
      password: z.string().min(12, 'Too short').regex(/\d/, 'Needs a digit'),
    });
    const result = strict.safeParse({ password: 'short' });
    const details = zodToDetails(result.success ? new z.ZodError([]) : result.error);

    expect(details.password).toEqual(['Too short', 'Needs a digit']);
  });

  it('files a root-level issue under "_"', () => {
    const result = z.string().safeParse(42);
    const details = zodToDetails(result.success ? new z.ZodError([]) : result.error);

    expect(Object.keys(details)).toEqual(['_']);
  });
});

describe('fromZodError', () => {
  it('is a 422 carrying the field details', () => {
    const result = z.object({ email: z.string().email() }).safeParse({ email: 'x' });
    const error = fromZodError(result.success ? new z.ZodError([]) : result.error);

    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      message: 'Validation failed',
    });
    expect(error.details).toHaveProperty('email');
  });
});

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new AppError('GONE', 'Expired');
    expect(toAppError(original)).toBe(original);
  });

  it('recognises a ZodError and gives it a 422', () => {
    const result = z.object({ a: z.number() }).safeParse({ a: 'x' });
    expect(toAppError(result.success ? null : result.error)).toMatchObject({ status: 422 });
  });

  /** Nothing about the failure may reach the caller — only the cause, server-side. */
  it('collapses an arbitrary Error into a generic INTERNAL, keeping the cause', () => {
    const raw = new Error('relation "users" does not exist');
    const error = toAppError(raw);

    expect(error).toMatchObject({ code: 'INTERNAL', status: 500, message: 'Something went wrong' });
    expect(error.cause).toBe(raw);
    expect(JSON.stringify(error.toJSON())).not.toContain('relation');
  });

  it('handles thrown values that are not Errors at all', () => {
    for (const thrown of ['a string', 42, null, undefined, { code: 'nope' }]) {
      const error = toAppError(thrown);
      expect(error, String(thrown)).toBeInstanceOf(AppError);
      expect(error.code).toBe('INTERNAL');
    }
  });
});

describe('isErrorCode', () => {
  it('accepts every member of the union', () => {
    for (const code of ERROR_CODES) expect(isErrorCode(code), code).toBe(true);
  });

  it('rejects anything else, including prototype keys', () => {
    for (const value of ['nope', '', 'toString', 'constructor', 42, null, undefined, {}]) {
      expect(isErrorCode(value), String(value)).toBe(false);
    }
  });
});
