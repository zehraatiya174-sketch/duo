import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import * as React from 'react';

import { AdminDashboard } from '@/features/admin/components/admin-dashboard';
import { getCurrentUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Admin' };

// Every panel reads live state; none of it may be cached.
export const dynamic = 'force-dynamic';

/**
 * The operations console.
 *
 * `notFound()` rather than a redirect or a 403: to the member account this
 * route should not appear to exist at all. A 403 confirms there is something
 * here worth finding, and the two people using this deployment already know
 * each other — the only thing a distinct error would reveal is which of them
 * holds the admin role.
 *
 * This is the second gate, not the only one. Every `/api/admin/*` handler runs
 * `adminRoute`, so the panels below cannot fetch anything a non-admin could not
 * already fetch directly.
 */
export default async function AdminPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user?.isAdmin) notFound();

  return <AdminDashboard />;
}
