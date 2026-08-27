import { adminEmail, authorizedEmails } from '@/lib/env';

/**
 * The allowlist gate.
 *
 * This deployment is for exactly two people, named by `AUTHORIZED_USER_1` and
 * `AUTHORIZED_USER_2`. Registration, sign-in, and the socket handshake all pass
 * through here, which is what makes the app private by construction rather than
 * by nobody knowing the URL.
 *
 * Checked on every request rather than only at sign-up: a session issued before
 * the environment changed must stop working the moment its address is removed.
 */
/**
 * The one spelling of an address the whole app agrees on.
 *
 * Addresses arrive from three places — a typed form, a Google profile, and the
 * environment — and any disagreement about case or padding between them would
 * let the same person register twice or fail the allowlist check on one path
 * but not another.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAuthorizedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return authorizedEmails().includes(normalizeEmail(email));
}

/**
 * Whether an address holds the admin console.
 *
 * One of the two is the operator; the other is not. This is only ever a
 * secondary check — the authoritative answer is `User.role`, written at
 * provisioning time — but it is what lets a route decide before it has loaded
 * a row.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return normalizeEmail(email) === adminEmail();
}

/**
 * The other participant's address, given one of them.
 *
 * Returns null when the caller is not on the list — the peer of a stranger is
 * not a meaningful question, and returning an address there would leak one.
 */
export function peerEmailOf(email: string): string | null {
  const normalised = email.trim().toLowerCase();
  const [first, second] = authorizedEmails();
  if (normalised === first) return second;
  if (normalised === second) return first;
  return null;
}
