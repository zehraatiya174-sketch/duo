import { createHmac } from 'node:crypto';

import { cookies } from 'next/headers';

import { safeEqual } from '@/lib/crypto';
import { serverEnv } from '@/lib/env';

import { VERIFICATION_COOKIE, VERIFICATION_PATH } from './verification.shared';

/**
 * A second gate after sign-in.
 *
 * Knowing the account password is not, on its own, enough to open the
 * conversation: the holder must also enter a shared phrase. The phrase itself
 * never leaves the server — the browser only ever holds a signed, expiring
 * ticket saying that *this* user cleared the gate — and it is read only from
 * `VERIFICATION_PASSPHRASE`. There is no fallback value anywhere in the source.
 */

export { VERIFICATION_COOKIE, VERIFICATION_PATH };

interface Ticket {
  userId: string;
  /** Unix seconds. */
  exp: number;
}

function sign(ticket: Ticket): string {
  // Bound to BETTER_AUTH_SECRET, so revoking that invalidates every outstanding
  // ticket along with every session.
  return createHmac('sha256', serverEnv().BETTER_AUTH_SECRET)
    .update(`${ticket.userId}|${ticket.exp}`)
    .digest('base64url');
}

export function verificationRequired(): boolean {
  return serverEnv().VERIFICATION_ENABLED;
}

/**
 * True when the phrase matches. Compared in constant time.
 *
 * Fails closed when nothing is configured. `serverEnv()` already refuses to boot
 * in that state, so this is the belt to that braces: there is no code path where
 * an unset passphrase becomes an open door.
 */
export function passphraseMatches(candidate: string): boolean {
  const expected = serverEnv().VERIFICATION_PASSPHRASE;
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

export function issueTicket(userId: string): { value: string; maxAge: number } {
  const maxAge = serverEnv().VERIFICATION_TTL_HOURS * 3600;
  const ticket: Ticket = { userId, exp: Math.floor(Date.now() / 1000) + maxAge };
  return { value: `${ticket.exp}.${sign(ticket)}`, maxAge };
}

function ticketIsValid(userId: string, raw: string | undefined): boolean {
  if (!raw) return false;

  const [rawExp, signature] = raw.split('.');
  if (!rawExp || !signature) return false;

  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;

  return safeEqual(sign({ userId, exp }), signature);
}

/**
 * Whether this request already cleared the gate.
 *
 * The ticket is bound to the user id, so it cannot be carried across accounts,
 * and it is signed, so it cannot be forged by editing the cookie.
 */
export async function isVerified(userId: string): Promise<boolean> {
  if (!verificationRequired()) return true;
  const store = await cookies();
  return ticketIsValid(userId, store.get(VERIFICATION_COOKIE)?.value);
}

/**
 * As `isVerified`, but for callers outside the Next request scope.
 *
 * The socket server sees a raw handshake, not `next/headers`, and it needs the
 * same answer: an unverified session must not be able to open a realtime
 * channel and receive the messages the gate is there to withhold.
 */
export function isVerifiedCookieHeader(userId: string, header: string | undefined): boolean {
  if (!verificationRequired()) return true;
  if (!header) return false;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== VERIFICATION_COOKIE) continue;
    return ticketIsValid(userId, decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return false;
}
