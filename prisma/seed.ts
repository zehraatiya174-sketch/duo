import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { authorizedEmails, adminEmail } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { ensureDuoChat, provisionUser } from '@/services/provisioning';

const log = createLogger('seed');

export interface SeedOptions {
  /**
   * Password to set on both accounts. Omit to leave existing credentials alone
   * and only create what is missing.
   */
  password?: string;
  /**
   * Overwrite the password even on accounts that already have one. The E2E
   * suite needs this; a real deployment must never pass it.
   */
  forcePassword?: boolean;
}

export interface SeededAccount {
  id: string;
  email: string;
  created: boolean;
}

export interface SeedResult {
  accounts: SeededAccount[];
  chatId: string | null;
}

/**
 * Brings a database up to the state the application assumes.
 *
 * Creates the two allowlisted accounts, their profiles and settings, and the
 * single shared conversation. Every step is an upsert, so running this against
 * a populated database is safe and changes nothing — which is what makes it
 * usable both as a first-run bootstrap and as the E2E setup step.
 *
 * Messages are never seeded. A chat with invented history is worse than an
 * empty one: it looks like data loss the first time somebody opens it.
 */
export async function seed(options: SeedOptions = {}): Promise<SeedResult> {
  const emails = authorizedEmails();
  const admin = adminEmail();
  const accounts: SeededAccount[] = [];

  for (const email of emails) {
    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      accounts.push({ id: existing.id, email, created: false });

      if (options.password && options.forcePassword) {
        await setPassword(existing.id, email, options.password);
      }
      continue;
    }

    const user = await db.user.create({
      data: {
        email,
        name: email.split('@')[0] ?? 'User',
        emailVerified: true,
        role: email === admin ? 'ADMIN' : 'MEMBER',
      },
      select: { id: true, email: true, name: true, image: true },
    });

    // The same code path Better Auth's create hook uses, so a seeded account is
    // indistinguishable from a registered one.
    await provisionUser(user);

    if (options.password) {
      await setPassword(user.id, email, options.password);
    }

    accounts.push({ id: user.id, email, created: true });
    log.info('Seeded account', { email });
  }

  const chatId = await ensureDuoChat();

  return { accounts, chatId };
}

/**
 * Writes a credential account row.
 *
 * Better Auth stores password credentials as an `Account` with
 * `providerId: 'credential'`; there is no password column on `User`. The hash
 * uses the same Argon2 parameters the sign-in path verifies against.
 *
 * `accountId` must be the **user id**, not the email. Better Auth looks the
 * credential up by `(providerId, accountId)` and treats the id as the subject
 * within the provider — for `credential` that subject is the local user. An
 * email here produces a row that looks correct in the table and fails every
 * sign-in with "Invalid email or password".
 */
async function setPassword(userId: string, _email: string, password: string): Promise<void> {
  const hashed = await hashPassword(password);

  const existing = await db.account.findFirst({
    where: { userId, providerId: 'credential' },
    select: { id: true },
  });

  if (existing) {
    await db.account.update({
      where: { id: existing.id },
      data: { password: hashed, accountId: userId },
    });
    return;
  }

  await db.account.create({
    data: { userId, providerId: 'credential', accountId: userId, password: hashed },
  });
}

/**
 * `npm run db:seed`
 *
 * `SEED_FORCE_PASSWORD=true` resets the credential on accounts that already
 * exist. Off by default so a routine re-seed of a live database cannot silently
 * change someone's password.
 */
async function main(): Promise<void> {
  const result = await seed({
    password: process.env['SEED_PASSWORD'],
    forcePassword: process.env['SEED_FORCE_PASSWORD'] === 'true',
  });

  for (const account of result.accounts) {
    log.info(account.created ? 'Created' : 'Already present', { email: account.email });
  }

  if (!result.chatId) {
    log.warn('Both accounts must exist before the conversation can be created');
  }
}

// Only when executed directly — importing this from the E2E setup must not run it.
if (process.argv[1]?.includes('seed')) {
  main()
    .catch((error: unknown) => {
      log.error('Seed failed', { error });
      process.exitCode = 1;
    })
    .finally(() => {
      void db.$disconnect();
    });
}
