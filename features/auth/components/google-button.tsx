'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { signIn } from '@/lib/auth/client';

/** The wordmark, inlined — an external asset would violate the CSP. */
function GoogleMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.11 0 5.72-1.03 7.62-2.8l-3.72-2.88c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.55-2.03-6.46-4.76H1.69v2.98A11.5 11.5 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.54 14.66a6.9 6.9 0 0 1 0-4.4V7.28H1.69a11.5 11.5 0 0 0 0 10.36l3.85-2.98Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.72 1.2 15.11 0 12 0 7.48 0 3.57 2.6 1.69 6.38l3.85 2.98C6.45 6.78 9 4.75 12 4.75Z"
      />
    </svg>
  );
}

/**
 * Google sign-in.
 *
 * Only ever a second door into the same two accounts — the allowlist runs in
 * Better Auth's `user.create.before` hook, so an unrecognised Google address is
 * rejected before a row exists. Nothing here needs to check that, and checking
 * it here instead would be security theatre on the client.
 *
 * The loading state is never cleared on success: the browser is navigating away
 * to Google, and re-enabling the button mid-redirect invites a double click.
 */
export function GoogleButton({
  callbackURL = '/',
  onError,
}: {
  callbackURL?: string;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const [pending, setPending] = React.useState(false);

  const start = async (): Promise<void> => {
    setPending(true);
    try {
      await signIn.social({ provider: 'google', callbackURL });
    } catch (error) {
      setPending(false);
      onError?.(
        error instanceof Error ? error.message : 'Could not start sign-in with Google',
      );
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="lg"
      block
      loading={pending}
      onClick={() => void start()}
    >
      <GoogleMark />
      Continue with Google
    </Button>
  );
}
