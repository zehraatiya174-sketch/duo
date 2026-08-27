// @vitest-environment node
import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IceConfigDTO } from '@/types/models';

/**
 * The relay configuration handed to the browser before every call.
 *
 * Getting this wrong does not throw — it produces a call that rings, connects
 * to nothing, and times out. So the ordering, the credentials and the failover
 * shape are asserted here rather than discovered on a hotel network.
 */

const USER_ID = 'usr_alice';

/** Only the fields this route reads. */
type EnvOverrides = Partial<{
  STUN_URLS: string;
  TURN_URLS: string;
  TURN_USERNAME: string;
  TURN_CREDENTIAL: string;
  TURN_STATIC_AUTH_SECRET: string;
  TURN_CREDENTIAL_TTL_SECONDS: number;
  TURN_FORCE_RELAY: boolean;
}>;

const env = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/lib/env', () => ({ serverEnv: () => env.current }));

// The route's auth wrapper is not under test here; unwrap it so the handler can
// be called directly with a known user.
vi.mock('@/lib/api/respond', () => ({
  authedRoute:
    (handler: (ctx: { user: { id: string } }) => Promise<Response>) => async (): Promise<Response> =>
      handler({ user: { id: USER_ID } }),
}));

const { GET } = await import('@/app/api/calls/ice-servers/route');

function configure(overrides: EnvOverrides): void {
  env.current = {
    STUN_URLS: 'stun:stun.example.net:3478',
    TURN_CREDENTIAL_TTL_SECONDS: 3_600,
    TURN_FORCE_RELAY: false,
    ...overrides,
  };
}

async function fetchConfig(): Promise<{ body: IceConfigDTO; response: Response }> {
  const response = await (GET as unknown as () => Promise<Response>)();
  return { body: (await response.json()) as IceConfigDTO, response };
}

/** The relay entries, in the order the browser will receive them. */
async function turnEntries(): Promise<IceConfigDTO['iceServers']> {
  const { body } = await fetchConfig();
  return body.iceServers.filter((server) => server.urls.some((url) => url.startsWith('turn')));
}

beforeEach(() => {
  configure({});
});

describe('endpoint ordering', () => {
  it('puts TURN over TLS on 443 first, because it is the one that survives a proxy', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478,turns:relay.example.net:443?transport=tcp',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    });

    const entries = await turnEntries();

    expect(entries[0]?.urls).toEqual(['turns:relay.example.net:443?transport=tcp']);
  });

  it('ranks tls/443 over other tls, then tcp, then plain udp', async () => {
    configure({
      TURN_URLS: [
        'turn:relay.example.net:3478',
        'turn:relay.example.net:3478?transport=tcp',
        'turns:relay.example.net:5349',
        'turns:relay.example.net:443?transport=tcp',
      ].join(','),
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    });

    const entries = await turnEntries();

    expect(entries.flatMap((entry) => entry.urls)).toEqual([
      'turns:relay.example.net:443?transport=tcp',
      'turns:relay.example.net:5349',
      'turn:relay.example.net:3478?transport=tcp',
      'turn:relay.example.net:3478',
    ]);
  });

  it('keeps the configured order between endpoints of equal rank', async () => {
    configure({
      TURN_URLS: 'turns:b.example.net:443,turns:a.example.net:443',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    });

    const entries = await turnEntries();

    // Stable: a provider listed first stays first, so the ordering is the
    // operator's preference and not an alphabetical accident.
    expect(entries.flatMap((entry) => entry.urls)).toEqual([
      'turns:b.example.net:443',
      'turns:a.example.net:443',
    ]);
  });

  it('still offers an endpoint it could not parse, sorted last', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478,turn:weird.example.net:3478?transport=quic',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    });

    const urls = (await turnEntries()).flatMap((entry) => entry.urls);

    // The browser is the authority on what it accepts; this route does not
    // silently drop a relay the operator deliberately configured.
    expect(urls).toContain('turn:weird.example.net:3478?transport=quic');
    expect(urls.at(-1)).toBe('turn:weird.example.net:3478?transport=quic');
  });

  it('offers STUN before any relay, so a direct path is preferred', async () => {
    configure({ TURN_URLS: 'turns:relay.example.net:443', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });

    const { body } = await fetchConfig();

    expect(body.iceServers[0]?.urls).toEqual(['stun:stun.example.net:3478']);
  });
});

describe('failover across multiple relays', () => {
  it('emits one entry per endpoint rather than one entry listing them all', async () => {
    configure({
      TURN_URLS: 'turns:a.example.net:443,turns:b.example.net:443,turn:c.example.net:3478',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    });

    const entries = await turnEntries();

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.urls.length === 1)).toBe(true);
  });

  it('credentials every endpoint, so a fallback relay is usable when reached', async () => {
    configure({
      TURN_URLS: 'turns:a.example.net:443,turn:b.example.net:3478',
      TURN_USERNAME: 'shared-user',
      TURN_CREDENTIAL: 'shared-pass',
    });

    const entries = await turnEntries();

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({ username: 'shared-user', credential: 'shared-pass' });
    }
  });
});

describe('authentication', () => {
  it('passes a long-lived username and credential through unchanged', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478',
      TURN_USERNAME: 'provider-user',
      TURN_CREDENTIAL: 'provider-pass',
    });

    expect((await turnEntries())[0]).toMatchObject({
      username: 'provider-user',
      credential: 'provider-pass',
    });
  });

  it('mints coturn REST credentials bound to the user and to an expiry', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478',
      TURN_STATIC_AUTH_SECRET: 'shared-secret',
      TURN_CREDENTIAL_TTL_SECONDS: 600,
    });

    const entry = (await turnEntries())[0];
    const [expiry, subject] = (entry?.username ?? '').split(':');

    expect(subject).toBe(USER_ID);
    // Expires on its own, so a credential lifted from devtools stops working.
    const secondsAway = Number(expiry) - Math.floor(Date.now() / 1000);
    expect(secondsAway).toBeGreaterThan(590);
    expect(secondsAway).toBeLessThanOrEqual(600);

    const expected = createHmac('sha1', 'shared-secret')
      .update(entry?.username ?? '')
      .digest('base64');
    expect(entry?.credential).toBe(expected);
  });

  it('prefers the REST secret over a static pair when both are configured', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478',
      TURN_USERNAME: 'static-user',
      TURN_CREDENTIAL: 'static-pass',
      TURN_STATIC_AUTH_SECRET: 'shared-secret',
    });

    const entry = (await turnEntries())[0];

    // An expiring credential beats one that stays valid until somebody notices.
    expect(entry?.username).not.toBe('static-user');
    expect(entry?.username).toContain(`:${USER_ID}`);
  });

  it('gives each user a distinct REST credential', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478',
      TURN_STATIC_AUTH_SECRET: 'shared-secret',
    });

    const first = (await turnEntries())[0]?.credential;
    const second = createHmac('sha1', 'shared-secret').update(`0:someone-else`).digest('base64');

    expect(first).not.toBe(second);
  });
});

describe('the reported configuration', () => {
  it('reports hasTurn false when no relay is configured', async () => {
    configure({});

    const { body } = await fetchConfig();

    expect(body.hasTurn).toBe(false);
    expect(body.iceServers.every((server) => !server.urls[0]?.startsWith('turn'))).toBe(true);
  });

  it('reports hasTurn true once a relay exists', async () => {
    configure({ TURN_URLS: 'turns:relay.example.net:443', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });

    expect((await fetchConfig()).body.hasTurn).toBe(true);
  });

  it('pins transport to relay only when explicitly forced', async () => {
    configure({ TURN_URLS: 'turns:relay.example.net:443', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
    expect((await fetchConfig()).body.iceTransportPolicy).toBe('all');

    configure({
      TURN_URLS: 'turns:relay.example.net:443',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
      TURN_FORCE_RELAY: true,
    });
    expect((await fetchConfig()).body.iceTransportPolicy).toBe('relay');
  });

  it('is never cached, since the credential it carries is per-session', async () => {
    configure({
      TURN_URLS: 'turn:relay.example.net:3478',
      TURN_STATIC_AUTH_SECRET: 'shared-secret',
    });

    const { response } = await fetchConfig();

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
