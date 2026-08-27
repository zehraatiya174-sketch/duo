/**
 * Constants shared by the verification gate and the browser.
 *
 * Split out of `./verification` because that module pulls in `node:crypto` and
 * `next/headers`; importing it from a client component would fail the build.
 */

export const VERIFICATION_COOKIE = 'duo.verified';

/** Where a signed-in but unverified session is sent. */
export const VERIFICATION_PATH = '/verify';
