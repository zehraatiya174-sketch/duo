import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import * as React from 'react';

import { VerificationForm } from '@/features/auth/components/verification-form';
import { getCurrentUser } from '@/lib/auth/session';
import { isVerified, verificationRequired } from '@/lib/auth/verification';
import { clientEnv } from '@/lib/env.client';

export const metadata: Metadata = { title: 'Verification' };

// The ticket lives in a cookie, so this page can never be cached.
export const dynamic = 'force-dynamic';

/** Same rule as the sign-in page: only same-site paths are followed. */
function safeRedirect(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

/**
 * The second gate.
 *
 * It sits outside both route groups on purpose: `(auth)` bounces signed-in
 * visitors away and `(app)` bounces unverified ones here, so a screen that needs
 * a session *and* a missing ticket cannot live in either.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const raw = params['next'];
  const destination = safeRedirect(typeof raw === 'string' ? raw : undefined);

  // Nothing to ask for: either the gate is switched off, or it is already open.
  if (!verificationRequired() || (await isVerified(user.id))) redirect(destination);

  return (
    <main
      id="main"
      className="relative flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10"
    >
      <div className="flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size inline SVG mark, not a content image. */}
        <img src="/icon.svg" alt="" width={52} height={52} className="rounded-[var(--radius-lg)]" />
        <p className="text-sm font-medium tracking-[0.2em] text-[var(--text-muted)]">
          {clientEnv.NEXT_PUBLIC_APP_NAME.toUpperCase()}
        </p>
      </div>

      <VerificationForm email={user.email} redirectTo={destination} />

      <p className="max-w-sm text-center text-xs leading-relaxed text-balance text-[var(--text-muted)]">
        A private space for two. Access is limited to the pre-authorized accounts.
      </p>
    </main>
  );
}
