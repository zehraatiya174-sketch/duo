import type { MessageView, ViewSessionState } from '@prisma/client';

/**
 * View-session accounting for sealed messages.
 *
 * A "look" is not an instant — it is reserved, rendered, then completed. Making
 * that a lifecycle rather than a counter is what lets the app tell three cases
 * apart that a naive `viewCount++` cannot:
 *
 * - the reader opened it and saw it            → the look is spent
 * - the reader is looking right now            → the look is held, not yet spent
 * - the reader tapped by accident and bailed   → the look is handed back
 *
 * Pure functions only; every caller supplies `now` so the sweep, the serializer
 * and the tests all agree on the instant being asked about.
 */

/**
 * How long a reservation survives without confirmation.
 *
 * Long enough to cover a slow video decode on a bad connection, short enough
 * that a reader who closes their laptop mid-view does not hold the allowance
 * for the rest of the day. Past this the sweep settles the session: a confirmed
 * render is committed, anything else is handed back.
 */
export const VIEW_LEASE_SECONDS = 90;

/**
 * How many times one viewer may back out of the same message before the release
 * stops being free.
 *
 * Without a cap, "open, see the first frame, release" is an unlimited peek —
 * the allowance is never charged but the content is served every time. After
 * this many releases the next one is charged as a completed look.
 */
export const MAX_RELEASES_PER_VIEWER = 3;

/** States that hold an allowance without having spent it yet. */
const PENDING_STATES: ReadonlySet<ViewSessionState> = new Set(['RESERVED', 'RENDERED']);

/**
 * A session is live while it is unsettled and its lease has not run out.
 *
 * A missing `leaseExpiresAt` is treated as expired rather than eternal: a row
 * written before leases existed, or by a failed transaction, must not be able
 * to pin an allowance permanently.
 */
export function isSessionActive(
  session: Pick<MessageView, 'state' | 'leaseExpiresAt'>,
  now: number = Date.now(),
): boolean {
  if (!PENDING_STATES.has(session.state)) return false;
  if (!session.leaseExpiresAt) return false;
  return session.leaseExpiresAt.getTime() > now;
}

export interface ConsumptionTally {
  /** Looks already taken and charged. */
  spent: number;
  /** Looks currently in progress — reserved or rendering, lease still valid. */
  held: number;
  /**
   * What the allowance check compares against. Held looks count: two tabs must
   * not each be told there is one look left when there is only one between them.
   */
  consumed: number;
}

/**
 * Totals one viewer's sessions against a message.
 *
 * `RELEASED` sessions are deliberately absent from every figure — that is the
 * whole point of releasing. They are still counted elsewhere, by
 * `MAX_RELEASES_PER_VIEWER`, to stop the release path becoming a free peek.
 */
export function countConsumed(
  sessions: ReadonlyArray<Pick<MessageView, 'state' | 'leaseExpiresAt'>>,
  now: number = Date.now(),
): ConsumptionTally {
  let spent = 0;
  let held = 0;

  for (const session of sessions) {
    if (session.state === 'COMPLETED') {
      spent += 1;
      continue;
    }
    if (isSessionActive(session, now)) held += 1;
    // Anything else — RELEASED, or an expired reservation the sweep has not yet
    // settled — costs the viewer nothing.
  }

  return { spent, held, consumed: spent + held };
}
