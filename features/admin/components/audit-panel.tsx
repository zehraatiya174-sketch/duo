'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuditLog } from '@/hooks/use-admin';
import { cn } from '@/lib/utils';
import type { AuditLogRow } from '@/services/admin';
import { formatAge, formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, type StatusTone } from './admin-shell';

const ALL = 'ALL';

/** Mirrors the enum the route accepts; anything else is rejected server-side. */
const ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'LOGOUT',
  'LOGOUT_ALL',
  'REGISTER_BLOCKED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
  'PROFILE_UPDATED',
  'SETTINGS_UPDATED',
  'DEVICE_REVOKED',
  'MESSAGE_DELETED',
  'MESSAGE_EDITED',
  'EPHEMERAL_VIEWED',
  'EPHEMERAL_PURGED',
  'ATTACHMENT_UPLOADED',
  'ATTACHMENT_DOWNLOADED',
  'RATE_LIMITED',
  'SUSPICIOUS_ACTIVITY',
  'CALL_STARTED',
  'CALL_ENDED',
  'APP_SETTINGS_UPDATED',
  'DISAPPEARING_MODE_CHANGED',
  'MESSAGES_HIDDEN',
  'MESSAGES_RESTORED',
  'VERIFICATION_PASSED',
  'VERIFICATION_FAILED',
] as const;

/**
 * Only the entries that mean something went wrong are coloured.
 *
 * Tinting every row would make the wall of routine activity unreadable, which
 * is the opposite of what an audit trail is for.
 */
const ACTION_TONE: Partial<Record<string, StatusTone>> = {
  LOGIN_FAILURE: 'danger',
  REGISTER_BLOCKED: 'danger',
  SUSPICIOUS_ACTIVITY: 'danger',
  RATE_LIMITED: 'warning',
  DEVICE_REVOKED: 'warning',
  MESSAGE_DELETED: 'warning',
  EPHEMERAL_PURGED: 'warning',
  VERIFICATION_FAILED: 'danger',
  MESSAGES_HIDDEN: 'warning',
  DISAPPEARING_MODE_CHANGED: 'warning',
  LOGIN_SUCCESS: 'positive',
  PASSWORD_CHANGED: 'positive',
  VERIFICATION_PASSED: 'positive',
  MESSAGES_RESTORED: 'positive',
};

const TONE_CHIP: Record<StatusTone, string> = {
  positive:
    'bg-[color-mix(in_oklch,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]',
  warning:
    'bg-[color-mix(in_oklch,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]',
  danger: 'bg-[color-mix(in_oklch,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
};

function humanise(action: string): string {
  return action.toLowerCase().replace(/_/g, ' ');
}

/** Metadata is free-form JSON, so it is rendered as data rather than prose. */
function MetadataLine({ metadata }: { metadata: unknown }): React.JSX.Element | null {
  const text = React.useMemo(() => {
    if (metadata === null || metadata === undefined) return null;
    try {
      const serialized = JSON.stringify(metadata);
      return serialized === '{}' ? null : serialized;
    } catch {
      return null;
    }
  }, [metadata]);

  if (!text) return null;

  return (
    <p className="mt-1 truncate font-mono text-[0.7rem] text-[var(--text-muted)]" title={text}>
      {text}
    </p>
  );
}

function AuditRow({ row }: { row: AuditLogRow }): React.JSX.Element {
  const tone = ACTION_TONE[row.action] ?? 'neutral';

  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3">
      <span
        className={cn(
          'shrink-0 rounded-full px-2.5 py-1 text-[0.68rem] font-semibold tracking-wide uppercase',
          TONE_CHIP[tone],
        )}
      >
        {humanise(row.action)}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-xs text-[var(--text-secondary)]">
          {row.userId ? `user ${row.userId.slice(-8)}` : 'system'}
          {row.ipAddress ? ` · ${row.ipAddress}` : ''}
        </p>
        <MetadataLine metadata={row.metadata} />
      </div>

      <time
        dateTime={row.createdAt}
        title={formatFull(row.createdAt)}
        className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums"
      >
        {formatAge(row.createdAt)}
      </time>
    </li>
  );
}

export function AuditPanel(): React.JSX.Element {
  const [filter, setFilter] = React.useState<string>(ALL);
  const audit = useAuditLog(filter === ALL ? undefined : filter);

  const rows = React.useMemo(
    () => audit.data?.pages.flatMap((page) => page.items) ?? [],
    [audit.data],
  );

  return (
    <AdminPanel
      title="Audit log"
      description="Security-relevant events, newest first. Written by the server, never by the client."
      action={
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-52" aria-label="Filter by action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All actions</SelectItem>
            {ACTIONS.map((action) => (
              <SelectItem key={action} value={action}>
                {humanise(action)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {audit.isLoading ? (
        <RowsSkeleton rows={6} />
      ) : audit.error ? (
        <PanelError error={audit.error} />
      ) : rows.length > 0 ? (
        <>
          <ul className="divide-y divide-[var(--hairline)]">
            {rows.map((row) => (
              <AuditRow key={row.id} row={row} />
            ))}
          </ul>

          {audit.hasNextPage ? (
            <div className="flex justify-center border-t border-[var(--hairline)] px-5 py-3">
              <Button
                variant="ghost"
                size="sm"
                loading={audit.isFetchingNextPage}
                onClick={() => void audit.fetchNextPage()}
              >
                Load older entries
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="px-5 py-6">
          <EmptyState
            title="Nothing logged"
            description={
              filter === ALL
                ? 'No audited events have happened yet.'
                : 'No events of that kind have been recorded.'
            }
          />
        </div>
      )}
    </AdminPanel>
  );
}
