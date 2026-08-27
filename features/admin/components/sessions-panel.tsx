'use client';

import { LogOut } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useAdminSessions, useRevokeSession } from '@/hooks/use-admin';
import { formatAge, formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton } from './admin-shell';

/**
 * Live sign-ins, with a revoke control.
 *
 * Revoking is not cosmetic: the socket server re-validates every open
 * connection against its session row every five minutes, and a revoked session
 * gets `session:revoked` and is disconnected. That is why this is worth a
 * confirmation — it signs a real device out.
 */
export function SessionsPanel(): React.JSX.Element {
  const sessions = useAdminSessions();
  const revoke = useRevokeSession();
  const { confirm, dialog } = useConfirm();

  const onRevoke = (id: string, label: string): void => {
    confirm({
      title: 'Sign this device out?',
      description: `${label} will be signed out and its realtime connection closed within a few minutes.`,
      confirmLabel: 'Sign out',
      destructive: true,
      onConfirm: async () => {
        try {
          await revoke.mutateAsync(id);
          toast.success('Session revoked');
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Could not revoke that session');
        }
      },
    });
  };

  if (sessions.isLoading) return <RowsSkeleton rows={3} />;
  if (sessions.error) return <PanelError error={sessions.error} />;

  const rows = sessions.data ?? [];

  return (
    <>
      <AdminPanel title="Sessions" description="Devices currently signed in.">
        {rows.length === 0 ? (
          <EmptyState title="No active sessions" description="Nobody is signed in right now." />
        ) : (
          <ul className="divide-y divide-[var(--hairline)]">
            {rows.map((session) => {
              const label = session.device?.label ?? 'Unknown device';

              return (
                <li key={session.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {label}
                    </p>
                    <p className="truncate text-xs text-[var(--text-muted)]">
                      {session.userEmail}
                      {session.ipAddress ? ` · ${session.ipAddress}` : ''}
                    </p>
                    <p
                      className="mt-0.5 text-xs text-[var(--text-muted)]"
                      title={formatFull(session.expiresAt)}
                    >
                      Signed in {formatAge(session.createdAt)} · expires{' '}
                      {formatAge(session.expiresAt)}
                    </p>
                  </div>

                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onRevoke(session.id, label)}
                    disabled={revoke.isPending}
                    aria-label={`Sign out ${label}`}
                  >
                    <LogOut />
                    Sign out
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </AdminPanel>

      {dialog}
    </>
  );
}
