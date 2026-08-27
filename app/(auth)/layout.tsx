import { redirect } from 'next/navigation';
import * as React from 'react';

import { getCurrentUser } from '@/lib/auth/session';
import { clientEnv } from '@/lib/env.client';

/**
 * Shell for the unauthenticated routes.
 *
 * Signed-in visitors are bounced to the app: leaving a working session on the
 * sign-in page invites a pointless second login.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (user) redirect('/');

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

      {children}

      <p className="max-w-sm text-center text-xs leading-relaxed text-balance text-[var(--text-muted)]">
        A private space for two. Access is limited to the pre-authorized accounts.
      </p>
    </main>
  );
}
