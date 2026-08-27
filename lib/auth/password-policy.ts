/**
 * Password rules, shared by the sign-up form and the server.
 *
 * Deliberately free of any import: `lib/validation/auth.ts` pulls this into the
 * browser bundle, and the hashing module next door depends on `@node-rs/argon2`,
 * a native addon that cannot be bundled for the client. Keeping the policy in
 * its own leaf module is what lets both halves apply the same rules.
 */

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Argon2 hashes the whole input, so a long passphrase costs nothing to accept.
 * The cap exists only to stop a multi-megabyte body being sent to the KDF.
 */
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordStrength = 'weak' | 'fair' | 'strong';

export interface PasswordAssessment {
  /** Human-readable rule violations. Empty means the password is acceptable. */
  issues: string[];
  strength: PasswordStrength;
  /** 0-4, for the meter under the field. */
  score: number;
}

/**
 * Sequences that make a password predictable regardless of its length.
 * Matched case-insensitively against the whole value.
 */
const COMMON_PATTERNS = [
  /^(.)\1+$/,
  /passw0?rd/i,
  /qwerty|asdfgh|zxcvbn/i,
  /12345|09876/,
  /letmein|welcome|admin|iloveyou/i,
];

/**
 * Scores a password and explains what is wrong with it.
 *
 * The rules favour length over character-class gymnastics: a long passphrase is
 * both stronger and likelier to be remembered than a short string with a
 * mandatory symbol bolted on the end. Only the length floor and the
 * predictable-pattern check can actually reject; variety contributes to the
 * meter but never blocks.
 */
export function assessPasswordStrength(value: string): PasswordAssessment {
  const issues: string[] = [];

  if (value.length < PASSWORD_MIN_LENGTH) {
    issues.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    issues.push(`Use at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (/\s{2,}/.test(value)) {
    issues.push('Avoid runs of consecutive spaces');
  }
  if (COMMON_PATTERNS.some((pattern) => pattern.test(value))) {
    issues.push('That is too easy to guess — avoid common words and sequences');
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((re) => re.test(value)).length;

  let score = 0;
  if (value.length >= PASSWORD_MIN_LENGTH) score += 1;
  if (value.length >= 16) score += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  if (issues.length > 0) score = Math.min(score, 1);

  const strength: PasswordStrength = score >= 4 ? 'strong' : score >= 2 ? 'fair' : 'weak';

  return { issues, strength, score };
}
