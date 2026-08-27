import { redirect } from 'next/navigation';
import * as React from 'react';

import { PreferencesProvider } from '@/components/providers/preferences-provider';
import { SessionProvider, type SessionUser } from '@/components/providers/session-provider';
import { getCurrentUser } from '@/lib/auth/session';
import { VERIFICATION_PATH, isVerified } from '@/lib/auth/verification';
import { getSettings } from '@/services/settings';

/**
 * Shell for every authenticated route.
 *
 * The session and the user's preferences are resolved on the server and handed
 * down as initial data. That removes two request waterfalls from first paint and
 * — more visibly — stops the app rendering in the default theme for a moment
 * before someone's chosen accent and font size arrive.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  // Second gate. Enforced again in every route handler, so this is the
  // convenience redirect rather than the access control itself.
  if (!(await isVerified(user.id))) redirect(VERIFICATION_PATH);

  const settings = await getSettings(user.id);

  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: user.role,
    isAdmin: user.isAdmin,
    username: user.profile?.username ?? user.email.split('@')[0] ?? 'you',
    displayName: user.profile?.displayName ?? user.name,
    avatarUrl: user.profile?.avatarUrl ?? user.image,
  };

  return (
    <SessionProvider user={sessionUser}>
      <PreferencesProvider initialSettings={settings}>
        <main id="main" className="h-dvh overflow-hidden">
          {children}
        </main>
      </PreferencesProvider>
    </SessionProvider>
  );
}
