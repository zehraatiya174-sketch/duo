// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = cookieStore.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));

const {
  VERIFICATION_COOKIE,
  isVerified,
  isVerifiedCookieHeader,
  issueTicket,
  passphraseMatches,
  verificationRequired,
} = await import('@/lib/auth/verification');

const USER = 'user_alice';
const OTHER = 'user_bob';

beforeEach(() => {
  cookieStore.clear();
});

describe('passphraseMatches', () => {
  it('accepts the configured phrase', () => {
    expect(passphraseMatches('sexy12')).toBe(true);
  });

  it('rejects anything else, including a prefix of the real phrase', () => {
    expect(passphraseMatches('sexy1')).toBe(false);
    expect(passphraseMatches('sexy123')).toBe(false);
    expect(passphraseMatches('SEXY12')).toBe(false);
    expect(passphraseMatches('')).toBe(false);
  });

  it('is on by default', () => {
    expect(verificationRequired()).toBe(true);
  });
});

describe('isVerified', () => {
  it('is false when no ticket has been issued', async () => {
    await expect(isVerified(USER)).resolves.toBe(false);
  });

  it('is true once a ticket for that user is present', async () => {
    cookieStore.set(VERIFICATION_COOKIE, issueTicket(USER).value);
    await expect(isVerified(USER)).resolves.toBe(true);
  });

  it('does not let one account use another account ticket', async () => {
    cookieStore.set(VERIFICATION_COOKIE, issueTicket(OTHER).value);
    await expect(isVerified(USER)).resolves.toBe(false);
  });

  it('rejects a ticket whose expiry was edited to buy more time', async () => {
    const [, signature] = issueTicket(USER).value.split('.');
    const farFuture = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
    cookieStore.set(VERIFICATION_COOKIE, `${farFuture}.${signature}`);
    await expect(isVerified(USER)).resolves.toBe(false);
  });

  it('rejects a ticket that has expired', async () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    // Signed correctly for that timestamp — only the clock rejects it.
    cookieStore.set(VERIFICATION_COOKIE, `${expired}.${issueTicket(USER).value.split('.')[1]}`);
    await expect(isVerified(USER)).resolves.toBe(false);
  });

  it('rejects malformed cookie values instead of throwing', async () => {
    for (const value of ['', 'nonsense', '.', '12345', 'abc.def']) {
      cookieStore.set(VERIFICATION_COOKIE, value);
      await expect(isVerified(USER)).resolves.toBe(false);
    }
  });
});

describe('isVerifiedCookieHeader', () => {
  it('finds the ticket among other cookies', () => {
    const ticket = issueTicket(USER).value;
    const header = `theme=dark; ${VERIFICATION_COOKIE}=${ticket}; better-auth.session_token=abc`;
    expect(isVerifiedCookieHeader(USER, header)).toBe(true);
  });

  it('is false with no header at all, which is what an unauthenticated upgrade looks like', () => {
    expect(isVerifiedCookieHeader(USER, undefined)).toBe(false);
    expect(isVerifiedCookieHeader(USER, 'theme=dark')).toBe(false);
  });

  it('does not match a cookie whose name merely ends with the ticket name', () => {
    const ticket = issueTicket(USER).value;
    expect(isVerifiedCookieHeader(USER, `not.${VERIFICATION_COOKIE}=${ticket}`)).toBe(false);
  });

  it('agrees with the request-scoped reader', async () => {
    const ticket = issueTicket(USER).value;
    cookieStore.set(VERIFICATION_COOKIE, ticket);
    await expect(isVerified(USER)).resolves.toBe(
      isVerifiedCookieHeader(USER, `${VERIFICATION_COOKIE}=${ticket}`),
    );
  });
});

describe('issueTicket', () => {
  it('reports the configured lifetime so the cookie and the ticket expire together', () => {
    expect(issueTicket(USER).maxAge).toBe(12 * 3600);
  });

  it('signs each user distinctly', () => {
    const [, a] = issueTicket(USER).value.split('.');
    const [, b] = issueTicket(OTHER).value.split('.');
    expect(a).not.toBe(b);
  });
});
