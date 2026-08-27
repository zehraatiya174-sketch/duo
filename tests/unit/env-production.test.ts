// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boot-time guards that stand between a development fallback and a
 * production deployment.
 *
 * Each of these prevents a failure that is expensive to diagnose in the field:
 * a socket that accepts any origin, a call that can never traverse symmetric
 * NAT, an auth URL that loops sign-in back to the login page, and a second gate
 * whose phrase is readable by anyone holding the source.
 */

const BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/duochat',
  BETTER_AUTH_SECRET: 'a'.repeat(48),
  BETTER_AUTH_URL: 'https://duo.example.com',
  AUTHORIZED_USER_1: 'alice@example.com',
  AUTHORIZED_USER_2: 'bob@example.com',
  MEDIA_URL_SECRET: 'b'.repeat(48),
  MEDIA_ENCRYPTION_KEY: 'c'.repeat(64),
  STORAGE_PROVIDER: 'local',
  NEXT_PUBLIC_APP_URL: 'https://duo.example.com',
  SOCKET_CORS_ORIGINS: 'https://duo.example.com',
  TURN_URLS: 'turn:turn.example.com:3478',
  TURN_USERNAME: 'relay-user',
  TURN_CREDENTIAL: 'relay-pass',
  VERIFICATION_PASSPHRASE: 'a-real-secret',
};

const original = { ...process.env };

/** Each case needs a fresh module: `serverEnv()` memoises its answer. */
async function loadEnv(overrides: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (
      key in BASE ||
      key === 'NEXT_PHASE' ||
      key.startsWith('VERIFICATION_') ||
      key.startsWith('TURN_')
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, BASE);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  return import('@/lib/env');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

describe('the production environment guard', () => {
  it('accepts a fully configured production environment', async () => {
    const { serverEnv } = await loadEnv({});

    expect(() => serverEnv()).not.toThrow();
  });

  it.each([
    ['BETTER_AUTH_URL', 'http://localhost:3000'],
    ['NEXT_PUBLIC_APP_URL', 'http://localhost:3000'],
    ['SOCKET_CORS_ORIGINS', 'http://localhost:3000'],
  ])('rejects %s left on its development value', async (name, devValue) => {
    const { serverEnv } = await loadEnv({ [name]: devValue });

    // The variable is named so the operator does not have to guess which one.
    expect(() => serverEnv()).toThrow(new RegExp(name));
  });

  it.each(['BETTER_AUTH_URL', 'NEXT_PUBLIC_APP_URL', 'SOCKET_CORS_ORIGINS'])(
    'rejects %s served over plain http',
    async (name) => {
      const { serverEnv } = await loadEnv({ [name]: 'http://duo.example.com' });

      expect(() => serverEnv()).toThrow(new RegExp(name));
    },
  );

  it('refuses to run STUN-only in production', async () => {
    const { serverEnv } = await loadEnv({ TURN_URLS: undefined });

    expect(() => serverEnv()).toThrow(/TURN_URLS/);
  });

  it('states the expected format, not merely the name', async () => {
    const { serverEnv } = await loadEnv({ TURN_URLS: undefined });

    expect(() => serverEnv()).toThrow(/symmetric NAT/);
  });

  it('reports every offending variable at once rather than one per restart', async () => {
    const { serverEnv } = await loadEnv({
      TURN_URLS: undefined,
      SOCKET_CORS_ORIGINS: 'http://localhost:3000',
    });

    let message = '';
    try {
      serverEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toMatch(/TURN_URLS/);
    expect(message).toMatch(/SOCKET_CORS_ORIGINS/);
  });

  it('accepts a comma-separated origin list whose first entry is public HTTPS', async () => {
    const { serverEnv } = await loadEnv({
      SOCKET_CORS_ORIGINS: 'https://duo.example.com,https://www.duo.example.com',
    });

    expect(() => serverEnv()).not.toThrow();
  });
});

describe('relay credentials', () => {
  it('refuses a relay with no credentials at all', async () => {
    const { serverEnv } = await loadEnv({
      TURN_URLS: 'turn:relay.example.com:3478',
      TURN_USERNAME: undefined,
      TURN_CREDENTIAL: undefined,
    });

    // Otherwise the allocation is refused and the only symptom is a call that
    // never connects, with nothing useful reported by the browser.
    expect(() => serverEnv()).toThrow(/TURN_USERNAME|TURN_STATIC_AUTH_SECRET/);
  });

  it('accepts a standard username and credential pair', async () => {
    const { serverEnv } = await loadEnv({
      TURN_URLS: 'turn:relay.example.com:3478',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    });

    expect(() => serverEnv()).not.toThrow();
  });

  it('accepts a coturn REST secret on its own', async () => {
    const { serverEnv } = await loadEnv({
      TURN_URLS: 'turn:relay.example.com:3478',
      TURN_USERNAME: undefined,
      TURN_CREDENTIAL: undefined,
      TURN_STATIC_AUTH_SECRET: 's',
    });

    expect(() => serverEnv()).not.toThrow();
  });

  it('rejects a half-configured static pair', async () => {
    const { serverEnv } = await loadEnv({
      TURN_URLS: 'turn:relay.example.com:3478',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: undefined,
    });

    expect(() => serverEnv()).toThrow(/TURN_CREDENTIAL|TURN_STATIC_AUTH_SECRET/);
  });
});

describe('the verification passphrase', () => {
  it('has no built-in fallback — an enabled gate without a phrase refuses to boot', async () => {
    const { serverEnv } = await loadEnv({
      VERIFICATION_PASSPHRASE: undefined,
      VERIFICATION_ENABLED: 'true',
    });

    expect(() => serverEnv()).toThrow(/VERIFICATION_PASSPHRASE/);
  });

  it('is not required when the gate is switched off', async () => {
    const { serverEnv } = await loadEnv({
      VERIFICATION_PASSPHRASE: undefined,
      VERIFICATION_ENABLED: 'false',
    });

    expect(() => serverEnv()).not.toThrow();
  });

  /** The old default. If this ever passes again, the fallback has come back. */
  it('does not resolve to the former hardcoded phrase', async () => {
    const { serverEnv } = await loadEnv({ VERIFICATION_PASSPHRASE: undefined });

    expect(() => serverEnv()).toThrow();
  });
});

/**
 * `next build` imports every route module to collect page data, which pulls in
 * this file. The Docker build stage has no TURN relay and no passphrase — and
 * must not be given them, since build arguments end up in image history. A
 * build that demanded runtime secrets would fail before it ever reached boot.
 */
describe('during `next build`', () => {
  const BUILD = { NEXT_PHASE: 'phase-production-build' };

  it('does not demand a TURN relay', async () => {
    const { serverEnv } = await loadEnv({ ...BUILD, TURN_URLS: undefined });

    expect(() => serverEnv()).not.toThrow();
  });

  it('does not demand the verification passphrase', async () => {
    const { serverEnv } = await loadEnv({
      ...BUILD,
      VERIFICATION_PASSPHRASE: undefined,
      VERIFICATION_ENABLED: 'true',
    });

    expect(() => serverEnv()).not.toThrow();
  });

  it('tolerates the placeholder origins the build stage supplies', async () => {
    const { serverEnv } = await loadEnv({
      ...BUILD,
      BETTER_AUTH_URL: 'http://localhost:3000',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      SOCKET_CORS_ORIGINS: undefined,
      TURN_URLS: undefined,
    });

    expect(() => serverEnv()).not.toThrow();
  });

  it('still rejects an environment that is malformed rather than merely absent', async () => {
    // Relaxing the deployment guards must not relax the schema itself.
    const { serverEnv } = await loadEnv({ ...BUILD, BETTER_AUTH_SECRET: 'too-short' });

    expect(() => serverEnv()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('enforces the guards again at boot, when the phase flag is absent', async () => {
    const { serverEnv } = await loadEnv({ NEXT_PHASE: undefined, TURN_URLS: undefined });

    expect(() => serverEnv()).toThrow(/TURN_URLS/);
  });
});

describe('outside production', () => {
  it('still allows localhost origins in development', async () => {
    const { serverEnv } = await loadEnv({
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:3000',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      SOCKET_CORS_ORIGINS: 'http://localhost:3000',
      TURN_URLS: undefined,
    });

    expect(() => serverEnv()).not.toThrow();
  });

  it('still requires the passphrase in development, because the gate is on', async () => {
    const { serverEnv } = await loadEnv({
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:3000',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      TURN_URLS: undefined,
      VERIFICATION_PASSPHRASE: undefined,
    });

    expect(() => serverEnv()).toThrow(/VERIFICATION_PASSPHRASE/);
  });
});
