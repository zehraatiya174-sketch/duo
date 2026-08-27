import { expect, type Page, test } from '@playwright/test';

import { E2E_PASSPHRASE, OUTSIDER_EMAIL, VERIFICATION_ENABLED, userOne } from './accounts';

/**
 * Getting in, and being kept out.
 *
 * The whole product rests on the claim that exactly two people can reach it, so
 * these specs spend most of their attention on the refusals: an anonymous
 * visitor, a wrong password, an address that is not on the allowlist, and a
 * registration page with no seats left.
 */

// Signed out: these must not inherit a session from the setup project.
test.use({ storageState: { cookies: [], origins: [] } });

/** Walks through the second gate, when the deployment has one. */
async function clearVerification(page: Page): Promise<void> {
  if (!VERIFICATION_ENABLED) return;
  await expect(page).toHaveURL(/\/verify/);
  await page.getByLabel('Passphrase').fill(E2E_PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('sends an anonymous visitor to the sign-in page', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('keeps an anonymous visitor out of settings and the admin console', async ({ page }) => {
  for (const path of ['/settings', '/admin']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login/);
  }
});

test('refuses a wrong password without revealing that the account exists', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Email').fill(userOne().email);
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Incorrect email or password.');
  // The same wording an unknown address gets: the message must not become a
  // way to test which of two addresses is real.
  await expect(alert).not.toContainText(/not found|no account|unknown/i);
  await expect(page).toHaveURL(/\/login/);
});

test('refuses an address that is not on the allowlist', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Email').fill(OUTSIDER_EMAIL);
  await page.getByLabel('Password').fill('Whatever-Password-1!');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
});

test('closes registration once both seats are claimed', async ({ page }) => {
  await page.goto('/register');

  await expect(page.getByRole('heading', { name: 'Registration is closed' })).toBeVisible();
  await expect(page.getByText('No further accounts can be created.')).toBeVisible();
  // No form at all, not a form that fails on submit.
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
});

test('validates the form before it reaches the server', async ({ page }) => {
  await page.goto('/login');

  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(/\/login/);
});

test('signs in, keeps the session across a reload, and signs out again', async ({ page }) => {
  const account = userOne();

  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await clearVerification(page);

  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeVisible();

  await page.reload();
  await expect(composer).toBeVisible();

  await page.goto('/settings?tab=security');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  // Signing out asks first; the confirmation lives in a dialog.
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();

  await expect(page).toHaveURL(/\/login/);

  // And the session is genuinely gone, not merely navigated away from.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('holds a correct password at the passphrase gate', async ({ page }) => {
  test.skip(!VERIFICATION_ENABLED, 'VERIFICATION_ENABLED=false — there is no gate to test');
  const account = userOne();

  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/verify/);
  // The conversation is not merely hidden behind the screen.
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);

  await page.getByLabel('Passphrase').fill('not-the-passphrase');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('alert')).toHaveText('That passphrase is not correct.');
  await expect(page).toHaveURL(/\/verify/);

  // Nor can it be reached by navigating straight past the screen.
  await page.goto('/');
  await expect(page).toHaveURL(/\/verify/);

  await page.getByLabel('Passphrase').fill(E2E_PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('offers a way back in from a forgotten password', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();

  await expect(page).toHaveURL(/\/forgot-password/);
  await expect(page.getByLabel('Email')).toBeVisible();

  // The response must be identical whether or not the address is one of the
  // two, or it becomes an account-enumeration oracle.
  await page.getByLabel('Email').fill(OUTSIDER_EMAIL);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await expect(page.getByText(/belongs to an account here/)).toBeVisible();
});
