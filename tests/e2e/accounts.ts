import path from 'node:path';

/**
 * The two accounts every end-to-end spec signs in as.
 *
 * The application admits exactly the addresses named in the environment, so the
 * suite cannot invent its own fixtures: it uses the real allowlist and lets the
 * setup project give both accounts a known password.
 */

export interface TestAccount {
  /** Which of the two, for readable test titles. */
  label: 'user 1' | 'user 2';
  email: string;
  password: string;
  /** Where the signed-in cookie jar for this account is written. */
  storageState: string;
}

/** Deliberately noisy: nothing about this belongs in a real deployment. */
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-Only-Password-9!';

/** The second gate. Mirrors the server default when nothing overrides it. */
export const E2E_PASSPHRASE = process.env.VERIFICATION_PASSPHRASE ?? 'sexy12';

/** False when the deployment under test has the passphrase gate switched off. */
export const VERIFICATION_ENABLED = process.env.VERIFICATION_ENABLED !== 'false';

const AUTH_DIR = path.join(process.cwd(), 'tests', 'e2e', '.auth');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The end-to-end suite signs in as the two authorized accounts; ` +
        'copy .env.example to .env and fill it in before running `npm run test:e2e`.',
    );
  }
  return value.toLowerCase();
}

function account(label: TestAccount['label'], envName: string, file: string): TestAccount {
  return {
    label,
    email: required(envName),
    password: E2E_PASSWORD,
    storageState: path.join(AUTH_DIR, file),
  };
}

export function userOne(): TestAccount {
  return account('user 1', 'AUTHORIZED_USER_1', 'user-1.json');
}

export function userTwo(): TestAccount {
  return account('user 2', 'AUTHORIZED_USER_2', 'user-2.json');
}

/** An address the allowlist must never admit. */
export const OUTSIDER_EMAIL = 'not-invited@example.test';

/** A message body unique to one run, so parallel history cannot collide. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
