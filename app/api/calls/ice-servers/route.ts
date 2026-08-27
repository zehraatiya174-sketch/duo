import { createHmac } from 'node:crypto';

import { NextResponse } from 'next/server';

import { authedRoute } from '@/lib/api/respond';
import { serverEnv } from '@/lib/env';
import type { IceConfigDTO, IceServerDTO } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** `turn:` / `turns:` host, optional port, optional `?transport=`. */
const TURN_URL = /^(turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i;

/**
 * Ranks a relay endpoint by how likely it is to survive a hostile network.
 *
 * TURN over TLS on 443 is the one relay transport indistinguishable from
 * ordinary HTTPS, so it is what gets a call through captive portals, hotel
 * wifi and corporate proxies that drop everything else. Plain UDP is faster
 * and cheaper wherever it is permitted, so nothing here is pruned — the whole
 * list is still offered and this only decides the order.
 *
 * ICE picks the pair that actually works, by connectivity check rather than by
 * array position. What the ordering buys is *which relays get allocated
 * first*, so the most survivable candidate is in hand earliest in gathering
 * rather than after the ones that were never going to connect time out.
 */
function turnRank(url: string): number {
  const match = TURN_URL.exec(url);
  // Unrecognised shapes still go to the browser, which is the real authority on
  // what it accepts; they simply sort last rather than being silently dropped.
  if (!match) return 4;

  const [, scheme = '', , port, transport = ''] = match;
  const overTls = scheme.toLowerCase() === 'turns';

  if (overTls && port === '443') return 0;
  if (overTls) return 1;
  if (transport.toLowerCase() === 'tcp') return 2;
  return 3;
}

/** Most-survivable first, preserving the configured order within a rank. */
function orderTurnUrls(urls: string[]): string[] {
  return urls
    .map((url, index) => ({ url, index, rank: turnRank(url) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.url);
}

/**
 * Time-limited TURN credentials, in coturn's REST format.
 *
 * The username is `<expiry>:<user>` and the password is an HMAC of it under the
 * server's shared secret. The relay verifies that itself, so a credential that
 * leaks out of a browser stops working on its own rather than staying valid
 * until someone notices and rotates the static password.
 */
function restCredentials(
  secret: string,
  userId: string,
  ttlSeconds: number,
): { username: string; credential: string } {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/**
 * ICE configuration for the WebRTC peer connection.
 *
 * TURN credentials are handed out per-session through an authenticated endpoint
 * rather than baked into the client bundle, where they would be a free relay
 * for anyone who opened devtools.
 *
 * The STUN list is a pool rather than a single host: gathering asks all of them
 * at once and takes whichever answers first, so one operator having a bad day
 * costs nothing instead of costing every call its setup timeout.
 */
export const GET = authedRoute<Record<string, never>, IceConfigDTO>(async ({ user }) => {
  const env = serverEnv();

  const stunUrls = splitList(env.STUN_URLS);
  const turnUrls = orderTurnUrls(splitList(env.TURN_URLS));

  // STUN stays first: a direct path beats a relayed one on latency, cost and
  // privacy, and ICE will only fall back to TURN when it cannot find one.
  const iceServers: IceServerDTO[] = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });

  const ttlSeconds = env.TURN_CREDENTIAL_TTL_SECONDS;

  if (turnUrls.length > 0) {
    // coturn's REST scheme wins where both are configured: a credential that
    // expires on its own is strictly better than a static one that stays valid
    // until somebody notices it leaked.
    const credentials = env.TURN_STATIC_AUTH_SECRET
      ? restCredentials(env.TURN_STATIC_AUTH_SECRET, user.id, ttlSeconds)
      : {
          ...(env.TURN_USERNAME ? { username: env.TURN_USERNAME } : {}),
          ...(env.TURN_CREDENTIAL ? { credential: env.TURN_CREDENTIAL } : {}),
        };

    // One entry per endpoint rather than a single entry listing them all. The
    // browser allocates against every configured relay during gathering, so a
    // provider that is down, rate-limiting or rejecting credentials costs one
    // dead candidate instead of the call — failover needs no signalling and no
    // retry logic, it is just the relay that answered winning the checks.
    for (const url of turnUrls) iceServers.push({ urls: [url], ...credentials });
  }

  return NextResponse.json<IceConfigDTO>(
    {
      iceServers,
      hasTurn: turnUrls.length > 0,
      iceTransportPolicy: env.TURN_FORCE_RELAY ? 'relay' : 'all',
      // The client re-fetches shortly before this lapses, so a long call never
      // finds itself holding a credential the relay has already stopped honouring.
      ttlSeconds,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
});
