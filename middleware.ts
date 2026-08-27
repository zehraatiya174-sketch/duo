import { type NextRequest, NextResponse } from 'next/server';

import { VERIFICATION_COOKIE, VERIFICATION_PATH } from '@/lib/auth/verification.shared';

/**
 * Edge-side route gate.
 *
 * Two gates, and the order between them is load-bearing: **sign-in first, then
 * the passphrase.** Every other part of the app assumes it —
 * `app/verify/page.tsx` sends a visitor with no session to `/login`,
 * `/api/verification` is an authenticated route, and `socket/auth.ts` reads the
 * session before it reads the ticket. Putting the passphrase first would make
 * `/login` redirect to `/verify` while `/verify` redirects back to `/login`,
 * which is an infinite loop rather than a stricter gate.
 *
 * The passphrase is therefore a second factor on an account, not a doorman in
 * front of the building.
 *
 * Both checks are *optimistic*: they look for the presence of a cookie, never
 * its validity, so neither costs a database round trip. Real authorization
 * happens again in every server component and route handler — a forged cookie
 * gets past this middleware and no further.
 */

const PUBLIC_PREFIXES = [
  // Reachable without a ticket, or the gate could never be opened. `/verify`
  // itself is public so an authenticated-but-unverified visitor can load the
  // form; the page redirects them to `/login` if they have no session.
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

  // --- gate one: the session ------------------------------------------------
  if (!authenticated) {
    const loginUrl = new URL('/login', request.url);
    // Preserve the destination so sign-in can bounce the user back to it.
    if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // --- gate two: the passphrase ---------------------------------------------
  // Only reached with a session in hand, so `/verify` always has a user to ask.
  if (!hasVerificationTicket(request)) {
    const verifyUrl = new URL(VERIFICATION_PATH, request.url);
    if (pathname !== '/') verifyUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(verifyUrl);
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
