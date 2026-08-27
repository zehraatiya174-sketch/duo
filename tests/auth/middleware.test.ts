// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { VERIFICATION_COOKIE } from '@/lib/auth/verification.shared';
import { config, middleware } from '@/middleware';

const ORIGIN = 'https://duo.test';
const SESSION = 'better-auth.session_token';

function request(path: string, ...cookies: string[]): NextRequest {
  const req = new NextRequest(new URL(path, ORIGIN));
  for (const cookie of cookies) req.cookies.set(cookie, 'token-value');
  return req;
}

function locationOf(path: string, ...cookies: string[]): string | null {
  return middleware(request(path, ...cookies)).headers.get('location');
}

/** Everything past the first gate is tested with the ticket already held. */
function pastGate(path: string, ...cookies: string[]): string | null {
  return locationOf(path, VERIFICATION_COOKIE, ...cookies);
}

/**
 * The passphrase gate is a **second factor on an account**, not a doorman in
 * front of the building: sign-in is checked first, and only a visitor who
 * already holds a session is asked for the phrase.
 *
 * That ordering is not a preference. `app/verify/page.tsx` sends a visitor with
 * no session to `/login`, `/api/verification` is an authenticated route, and
 * `socket/auth.ts` reads the session before the ticket. Asking for the phrase
 * first makes `/login` redirect to `/verify` while `/verify` redirects back to
 * `/login` — an infinite loop, which is what this suite previously described.
 */
describe('the passphrase gate', () => {
  it('stands in front of the app and the API, once you are signed in', () => {
    for (const path of ['/', '/settings', '/api/messages', '/chat?m=abc']) {
      expect(locationOf(path, SESSION), path).toMatch(/\/verify/);
    }
  });

  it('does not stand in front of sign-in — that would be a redirect loop', () => {
    for (const path of ['/login', '/register', '/forgot-password', '/api/auth/sign-in/email']) {
      expect(locationOf(path), path).toBeNull();
    }
  });

  it('is asked for independently of how the session was obtained', () => {
    expect(locationOf('/', SESSION)).toBe(`${ORIGIN}/verify`);
  });

  it('keeps the destination so the gate can hand the visitor straight on', () => {
    expect(locationOf('/settings/privacy', SESSION)).toBe(
      `${ORIGIN}/verify?next=%2Fsettings%2Fprivacy`,
    );
    expect(locationOf('/chat?m=abc123', SESSION)).toBe(
      `${ORIGIN}/verify?next=%2Fchat%3Fm%3Dabc123`,
    );
  });

  it('is not given a redundant "next" for the root', () => {
    expect(locationOf('/', SESSION)).toBe(`${ORIGIN}/verify`);
  });

  it('lets through what is needed to clear it, or the gate could never open', () => {
    for (const path of ['/verify', '/verify?next=%2F', '/api/verification', '/api/health']) {
      expect(locationOf(path), path).toBeNull();
    }
  });

  it('does not accept an empty ticket cookie', () => {
    const req = new NextRequest(new URL('/', ORIGIN));
    req.cookies.set(SESSION, 'token-value');
    req.cookies.set(VERIFICATION_COOKIE, '');
    expect(middleware(req).headers.get('location')).toBe(`${ORIGIN}/verify`);
  });

  it('lets static and asset routes past untouched', () => {
    for (const path of [
      '/_next/static/chunk.js',
      '/favicon.ico',
      '/icons/badge.png',
      '/sounds/pop.mp3',
      '/manifest.webmanifest',
    ]) {
      expect(locationOf(path), path).toBeNull();
    }
  });
});

describe('unauthenticated visitors past the gate', () => {
  it('are sent to the sign-in page', () => {
    const response = middleware(request('/', VERIFICATION_COOKIE));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
  });

  it('keep their destination so sign-in can bounce them back', () => {
    expect(pastGate('/settings/privacy')).toBe(`${ORIGIN}/login?next=%2Fsettings%2Fprivacy`);
  });

  it('keep the query string of the destination too', () => {
    expect(pastGate('/chat?m=abc123')).toBe(`${ORIGIN}/login?next=%2Fchat%3Fm%3Dabc123`);
  });

  it('are not given a redundant "next" for the root', () => {
    expect(pastGate('/')).toBe(`${ORIGIN}/login`);
  });

  it('may reach the auth screens and the auth API', () => {
    for (const path of [
      '/login',
      '/register',
      '/forgot-password',
      '/reset-password?token=abc',
      '/api/auth/sign-in/email',
      '/api/health',
    ]) {
      expect(pastGate(path), path).toBeNull();
    }
  });
});

describe('authenticated visitors past the gate', () => {
  for (const cookie of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
    it(`are recognised by the ${cookie} cookie`, () => {
      expect(pastGate('/', cookie)).toBeNull();
    });
  }

  it('are kept out of the auth screens', () => {
    for (const path of ['/login', '/register', '/forgot-password']) {
      expect(pastGate(path, SESSION), path).toBe(`${ORIGIN}/`);
    }
  });

  it('may still open a password reset link, which is valid while signed in', () => {
    expect(pastGate('/reset-password?token=abc', SESSION)).toBeNull();
  });

  it('reach protected routes untouched', () => {
    expect(pastGate('/settings', SESSION)).toBeNull();
  });
});

describe('cookie presence', () => {
  it('does not accept an unrelated cookie as a session', () => {
    expect(pastGate('/', 'session')).toBe(`${ORIGIN}/login`);
  });

  it('does not accept an empty session cookie', () => {
    const req = new NextRequest(new URL('/', ORIGIN));
    req.cookies.set(VERIFICATION_COOKIE, 'ticket');
    req.cookies.set(SESSION, '');
    expect(middleware(req).headers.get('location')).toBe(`${ORIGIN}/login`);
  });
});

describe('matcher', () => {
  it('excludes the static asset paths that never need a session check', () => {
    const matcher = config.matcher[0];
    expect(matcher).toBeDefined();
    const pattern = new RegExp(`^${matcher}$`);

    expect(pattern.test('/chat')).toBe(true);
    expect(pattern.test('/_next/static/app.js')).toBe(false);
    expect(pattern.test('/logo.svg')).toBe(false);
    expect(pattern.test('/sounds/pop.mp3')).toBe(false);
  });
});
