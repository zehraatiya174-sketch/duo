import { hash, verify } from '@node-rs/argon2';

import { createLogger } from '@/lib/logger';

export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  assessPasswordStrength,
} from './password-policy';

const log = createLogger('auth:password');

/**
 * Argon2id parameters.
 *
 * Argon2id rather than bcrypt because it resists GPU and side-channel attacks
 * both; these settings are the OWASP baseline — 19 MiB of memory, two passes —
 * which costs roughly 50ms per hash on a small container. That is deliberately
 * slow: this runs twice a day for two people, so the only party who notices the
 * cost is someone trying to brute-force the hashes.
 *
 * Changing any value invalidates nothing: the parameters are encoded in the
 * hash string, so existing passwords keep verifying against their own settings.
 */
const OPTIONS = {
  // 2 = Argon2id
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/**
 * Constant-time comparison, delegated to the library.
 *
 * A malformed or truncated hash — a half-written row, a hand-edited value —
 * makes `verify` throw. That is treated as a failed sign-in rather than
 * propagated: an exception here would turn a corrupt row into a 500 and tell
 * an attacker that the account exists.
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password, OPTIONS);
  } catch (error) {
    log.warn('Password verification failed against a stored hash', { error });
    return false;
  }
}
