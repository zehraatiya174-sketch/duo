'use client';

import * as React from 'react';

import type { UserRole } from '@/types/models';

/**
 * The signed-in person, resolved on the server and handed down.
 *
 * Deliberately a plain value rather than a hook that fetches: every
 * authenticated screen needs it on the first render, and a client fetch would
 * put a spinner in front of the entire app on every navigation.
 *
 * This is display state, not authority. Nothing here is trusted server-side —
 * `isAdmin` decides whether a nav item renders, never whether an admin route
 * answers.
 */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: UserRole;
  isAdmin: boolean;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

const SessionContext = React.createContext<SessionUser | null>(null);

export function SessionProvider({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}): React.JSX.Element {
  // The object identity is stable for as long as the fields are, so consumers
  // do not re-render when an unrelated part of the layout does.
  const value = React.useMemo<SessionUser>(
    () => user,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      user.id,
      user.email,
      user.name,
      user.image,
      user.role,
      user.isAdmin,
      user.username,
      user.displayName,
      user.avatarUrl,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Throws outside the authenticated tree, where there is no user by definition. */
export function useSessionUser(): SessionUser {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSessionUser must be used inside a SessionProvider');
  return context;
}
