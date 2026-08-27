import { type NextRequest, NextResponse } from 'next/server';

import { VERIFICATION_COOKIE, VERIFICATION_PATH } from '@/lib/auth/verification.shared';

/**
 * Edge-side route gate.
 *
 * Two gates, in order. The **passphrase gate** comes first and stands in front
 * of everything — the app, the sign-in screens, and the auth API alike. That
 * ordering is the point: it means a visitor who does not know the phrase cannot
 * even reach the login form, so the deployment does not advertise itself as a
 * place where accounts exist. The **session gate** behind it then redirects
 * anyone not signed in.
 *
 * Both checks are *optimistic*: they look for the presence of a cookie, never
 * its validity, so neither costs a database round trip. Real authorization
 * happens again in every server component and route handler — a forged cookie
 * gets past this middleware and no further.
 */

/** Reachable without the passphrase, or the gate could never be opened. */
const GATE_EXEMPT_PREFIXES = [
  VERIFICATION_PATH,
  '/api/verification',
  '/api/health',
  '/_next',
  '/favicon.ico',
  '/icons',
  '/sounds',
  '/manifest.webmanifest',
];

const PUBLIC_PREFIXES = [
  // The passphrase gate is independent of sign-in: clearing it must not require
  // an account, or a signed-out visitor could never reach the form that lets
  // them sign in.
  VERIFICATION_PATH,
  '/api/verification',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/api/auth',
  '/api/health',
  '/_next',
  '/favicon.ico',
  '/icons',
  '/sounds',
  '/manifest.webmanifest',
];

const SESSION_COOKIE_NAMES = ['better-auth.session_token', '__Secure-better-auth.session_token'];

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix),
  );
}

function isPublicPath(pathname: string): boolean {
  return matchesPrefix(pathname, PUBLIC_PREFIXES);
}

/**
 * An empty cookie is not a ticket. `cookies.get()` returns an entry for a
 * cookie set to the empty string, so testing presence alone would let
 * `duo.verified=` through the gate.
 */
function hasVerificationTicket(request: NextRequest): boolean {
  return Boolean(request.cookies.get(VERIFICATION_COOKIE)?.value);
}

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => Boolean(request.cookies.get(name)?.value));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authenticated = hasSessionCookie(request);

  // --- gate one: the passphrase ---------------------------------------------
  if (!matchesPrefix(pathname, GATE_EXEMPT_PREFIXES) && !hasVerificationTicket(request)) {
    const verifyUrl = new URL(VERIFICATION_PATH, request.url);
    if (pathname !== '/') verifyUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(verifyUrl);
  }

  // --- gate two: the session ------------------------------------------------
  if (isPublicPath(pathname)) {
    // Keep signed-in users out of the auth screens.
    if (
      authenticated &&
      ['/login', '/register', '/forgot-password'].some((p) => pathname.startsWith(p))
    ) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (!authenticated) {
    const loginUrl = new URL('/login', request.url);
    // Preserve the destination so sign-in can bounce the user back to it.
    if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. The negative lookahead
     * keeps the middleware off the hot path for chunks and images.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|mp3|wav|woff|woff2)$).*)',
  ],
};
