import type { Metadata } from 'next';
import * as React from 'react';

import { LoginForm } from '@/features/auth/components/login-form';
import { isGoogleEnabled } from '@/lib/auth';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * The destination is validated as a same-site path before use — accepting an
 * arbitrary value here would turn the sign-in page into an open redirect.
 * `//evil.com` is rejected explicitly: it is protocol-relative, not a path.
 */
function safeRedirect(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  // `next` is the parameter the middleware writes when it bounces a visitor.
  const raw = params['next'];

  return (
    <LoginForm
      googleEnabled={isGoogleEnabled}
      redirectTo={safeRedirect(typeof raw === 'string' ? raw : undefined)}
    />
  );
}
