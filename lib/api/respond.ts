import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { requireAdmin, requireUser, type CurrentUser } from '@/lib/auth/session';
import { isVerified } from '@/lib/auth/verification';
import { AppError, fromZodError, toAppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { enforceRateLimit, type RateLimitName } from '@/lib/rate-limit';

const log = createLogger('api');

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export function errorResponse(error: unknown): NextResponse<ApiErrorBody> {
  const appError = error instanceof ZodError ? fromZodError(error) : toAppError(error);

  if (appError.status >= 500) {
    log.error('Request failed', { error, code: appError.code });
  }

  const headers: Record<string, string> = {};
  if (typeof appError.retryAfter === 'number') {
    headers['Retry-After'] = String(appError.retryAfter);
  }

  return NextResponse.json<ApiErrorBody>(
    {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
      },
    },
    { status: appError.status, headers },
  );
}

/** The identity a rate limit is bucketed against when nobody is signed in. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || 'anonymous';
}

export interface RouteContext<P> {
  request: Request;
  params: P;
}

export interface AuthedContext<P> extends RouteContext<P> {
  user: CurrentUser;
}

interface RouteOptions {
  rateLimit?: RateLimitName;
  /**
   * Exempts the route from the post-login passphrase gate.
   *
   * Only the verification endpoints themselves should set this: a gate that
   * required a ticket in order to obtain a ticket could never be cleared.
   */
  skipVerification?: boolean;
}

/**
 * Blocks a signed-in but unverified caller.
 *
 * The gate is enforced here as well as in the layout so that it is a real
 * access control rather than a screen: without this, anything the UI would have
 * shown is still one `fetch` away.
 */
async function assertVerified(user: CurrentUser, options: RouteOptions): Promise<void> {
  if (options.skipVerification) return;
  if (await isVerified(user.id)) return;
  throw new AppError('VERIFICATION_REQUIRED', 'Additional verification is required');
}

type NextRouteArgs<P> = { params: Promise<P> } | undefined;

async function resolveParams<P>(args: NextRouteArgs<P>): Promise<P> {
  // Next 15 hands route params in as a promise.
  return args ? await args.params : ({} as P);
}

/**
 * Wraps a route handler with error normalisation so an unexpected throw becomes
 * a well-formed JSON error instead of an HTML crash page — and so internal
 * details never reach the client (`toAppError` collapses unknowns).
 */
export function route<P = Record<string, string>, R = unknown>(
  handler: (ctx: RouteContext<P>) => Promise<NextResponse<R> | NextResponse<ApiErrorBody>>,
  options: RouteOptions = {},
) {
  return async (
    request: Request,
    args: NextRouteArgs<P>,
  ): Promise<NextResponse<R> | NextResponse<ApiErrorBody>> => {
    try {
      if (options.rateLimit) {
        await enforceRateLimit(options.rateLimit, clientKey(request));
      }
      const params = await resolveParams<P>(args);
      return await handler({ request, params });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** As `route`, but rejects anonymous callers and buckets limits per user. */
export function authedRoute<P = Record<string, string>, R = unknown>(
  handler: (ctx: AuthedContext<P>) => Promise<NextResponse<R> | NextResponse<ApiErrorBody>>,
  options: RouteOptions = {},
) {
  return async (
    request: Request,
    args: NextRouteArgs<P>,
  ): Promise<NextResponse<R> | NextResponse<ApiErrorBody>> => {
    try {
      const user = await requireUser();
      await assertVerified(user, options);
      if (options.rateLimit) {
        await enforceRateLimit(options.rateLimit, user.id);
      }
      const params = await resolveParams<P>(args);
      return await handler({ request, params, user });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** As `authedRoute`, but additionally requires the admin account. */
export function adminRoute<P = Record<string, string>, R = unknown>(
  handler: (ctx: AuthedContext<P>) => Promise<NextResponse<R> | NextResponse<ApiErrorBody>>,
  options: RouteOptions = {},
) {
  return async (
    request: Request,
    args: NextRouteArgs<P>,
  ): Promise<NextResponse<R> | NextResponse<ApiErrorBody>> => {
    try {
      const user = await requireAdmin();
      await assertVerified(user, options);
      if (options.rateLimit) {
        await enforceRateLimit(options.rateLimit, user.id);
      }
      const params = await resolveParams<P>(args);
      return await handler({ request, params, user });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Parses a JSON body, turning malformed input into a 400 rather than a 500. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Request body must be valid JSON');
  }
}

/** Collapses `URLSearchParams` into a plain object for Zod to validate. */
export function searchParamsToObject(url: string): Record<string, string> {
  const params = new URL(url).searchParams;
  const result: Record<string, string> = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}
