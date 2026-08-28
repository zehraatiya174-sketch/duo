'use client';

import { Check, Pencil, X } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { useAdminUsers, useRenameUser } from '@/hooks/use-admin';
import { formatAge, formatLastSeen } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatusDot } from './admin-shell';

/**
 * The two accounts.
 *
 * A list of exactly two rows is not a table — it is a pair of cards, and laying
 * it out as one would waste the whole width on a header for two entries.
 */
export function UsersPanel(): React.JSX.Element {
  const users = useAdminUsers();
  const rename = useRenameUser();

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');

  const submitRename = (userId: string): void => {
    const displayName = draft.trim();
    if (!displayName) return;
    rename.mutate(
      { userId, displayName },
      {
        onSuccess: () => {
          toast.success('Name updated');
          setEditingId(null);
        },
        onError: (error) => toast.error(error.message || 'Could not rename that account'),
      },
    );
  };

  if (users.isLoading) return <RowsSkeleton rows={2} />;
  if (users.error) return <PanelError error={users.error} />;

  const rows = users.data ?? [];

  return (
    <AdminPanel
      title="People"
      description="Renaming changes the name that person sees on their own profile — it is not a private nickname."
    >
      {rows.length === 0 ? (
        <EmptyState title="No accounts" description="Nobody has registered yet." />
      ) : (
        <ul className="divide-y divide-[var(--hairline)]">
          {rows.map((user) => (
            <li key={user.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar size="sm" name={user.name || user.email} />

              <div className="min-w-0 flex-1">
                {editingId === user.id ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={draft}
                      autoFocus
                      maxLength={60}
                      aria-label={`Display name for ${user.email}`}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitRename(user.id);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                      className="h-8"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      loading={rename.isPending}
                      disabled={!draft.trim()}
                      onClick={() => submitRename(user.id)}
                      aria-label="Save name"
                    >
                      <Check />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-[var(--text-primary)]">
                    {user.name || user.username || user.email}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Rename ${user.email}`}
                      onClick={() => {
                        setDraft(user.name || user.username || '');
                        setEditingId(user.id);
                      }}
                    >
                      <Pencil />
                    </Button>
                    {user.role === 'ADMIN' ? (
                      <span className="rounded-full bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-wide text-[var(--text-muted)] uppercase">
                        Admin
                      </span>
                    ) : null}
                    {user.banned ? (
                      <span className="rounded-full bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] px-1.5 py-0.5 text-[0.625rem] font-semibold text-[var(--color-danger)] uppercase">
                        Suspended
                      </span>
                    ) : null}
                  </p>
                )}
                <p className="truncate text-xs text-[var(--text-muted)]">{user.email}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)] tabular-nums">
                  {user.messageCount.toLocaleString()} messages · {user.deviceCount} device
                  {user.deviceCount === 1 ? '' : 's'} · joined {formatAge(user.createdAt)}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <StatusDot
                  tone={user.online ? 'positive' : 'neutral'}
                  label={user.online ? 'Online' : 'Offline'}
                  pulse={user.online}
                />
                {!user.online ? (
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {formatLastSeen(user.lastSeenAt)}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}
