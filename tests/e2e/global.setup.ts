import { expect, type Page, test as setup } from '@playwright/test';

import { seed } from '../../prisma/seed';
import {
  E2E_PASSPHRASE,
  E2E_PASSWORD,
  VERIFICATION_ENABLED,
  userOne,
  userTwo,
  type TestAccount,
} from './accounts';

/**
 * Prepares the database and both signed-in sessions.
 *
 * Every other spec starts from a cookie jar saved here, so the sign-in flow is
 * exercised once rather than at the top of each file. Sign-in runs through the
 * real form for the same reason: a cookie forged by the setup would prove
 * nothing about whether people can actually get in.
 */

setup('seeds the two authorized accounts', async () => {
  // `forcePassword` resets both credentials to a known value. That is exactly
  // what an E2E database is for, and exactly why E2E_SKIP_SEED exists for
  // anyone pointing the suite at an instance whose passwords matter.
  if (process.env.E2E_SKIP_SEED === 'true') {
    setup.skip(true, 'E2E_SKIP_SEED=true — using the existing accounts as they are');
    return;
  }

  const { accounts } = await seed({ password: E2E_PASSWORD, forcePassword: true });
  expect(accounts).toHaveLength(2);

  const { db } = await import('@/lib/db');
  await db.$disconnect();
});

async function signIn(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/login');

  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Sign-in lands on the second gate, not the conversation.
  if (VERIFICATION_ENABLED) {
    await expect(page).toHaveURL(/\/verify/);
    await page.getByLabel('Passphrase').fill(E2E_PASSPHRASE);
    await page.getByRole('button', { name: 'Continue' }).click();
  }

  // The conversation is the landing page; waiting for the composer proves the
  // session survived the redirect rather than just that the URL changed.
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

  await page.context().storageState({ path: account.storageState });
}

setup('signs in as user 1', async ({ page }) => {
  await signIn(page, userOne());
});

setup('signs in as user 2', async ({ page }) => {
  await signIn(page, userTwo());
});
