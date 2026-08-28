'use client';

import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { useSessionUser } from '@/components/providers/session-provider';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsDialog } from '@/features/settings/components/settings-dialog';
import { signOut } from '@/lib/auth/client';

/**
 * The account menu: settings, the admin console, and the way out.
 *
 * The admin entry is rendered from `isAdmin`, which is display state only —
 * `/admin` re-checks server-side and 404s for the member account, and every
 * `/api/admin/*` handler checks again. Hiding it here is courtesy, not a
 * control.
 */
export function UserMenu(): React.JSX.Element {
  const self = useSessionUser();
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  const onSignOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // Ignore: the cookie is cleared server-side either way, and stranding the
      // user on a screen they think they have left is the worse outcome.
    } finally {
      // `refresh` matters — without it the cached server component tree for the
      // authenticated layout can be reused for the next visitor to this tab.
      router.replace('/login');
      router.refresh();
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account menu"
          className="rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <Avatar size="sm" name={self.displayName} src={self.avatarUrl} />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel className="pb-0 text-[var(--text-primary)]">
            {self.displayName}
          </DropdownMenuLabel>
          <DropdownMenuLabel className="pt-0 font-normal">{self.email}</DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <Settings />
            Settings
          </DropdownMenuItem>

          {self.isAdmin ? (
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <ShieldCheck />
                Admin console
              </Link>
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            destructive
            disabled={signingOut}
            onSelect={(event) => {
              // Keep the menu mounted while the request is in flight, so the
              // click does not appear to do nothing on a slow connection.
              event.preventDefault();
              void onSignOut();
            }}
          >
            <LogOut />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
