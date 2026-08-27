'use client';

import { AlertTriangle, Bug, Flame } from 'lucide-react';
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
import { useErrorLog, useErrorSummary } from '@/hooks/use-admin';
import { cn } from '@/lib/utils';
import type { ErrorLogRow } from '@/services/diagnostics';
import { formatAge, formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatCard, type StatusTone } from './admin-shell';

const ALL = 'ALL';
const SEVERITIES = ['WARN', 'ERROR', 'FATAL'] as const;

const SEVERITY_TONE: Record<string, StatusTone> = {
  WARN: 'warning',
  ERROR: 'danger',
  FATAL: 'danger',
};

const TONE_CHIP: Record<StatusTone, string> = {
  positive:
    'bg-[color-mix(in_oklch,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]',
  warning:
    'bg-[color-mix(in_oklch,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]',
  danger: 'bg-[color-mix(in_oklch,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
};

/**
 * The stack is folded away by default.
 *
 * An error list is read by scanning the messages; a page of expanded traces
 * hides the one line that says which subsystem is unhappy.
 */
function ErrorRow({ row }: { row: ErrorLogRow }): React.JSX.Element {
  const tone = SEVERITY_TONE[row.severity] ?? 'neutral';

  const context = React.useMemo(() => {
    if (row.context === null || row.context === undefined) return null;
    try {
      const serialized = JSON.stringify(row.context);
      return serialized === '{}' ? null : serialized;
    } catch {
      return null;
    }
  }, [row.context]);

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-[0.68rem] font-semibold tracking-wide uppercase',
            TONE_CHIP[tone],
          )}
        >
          {row.severity.toLowerCase()}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text-primary)]">{row.message}</p>
          <p className="truncate font-mono text-[0.7rem] text-[var(--text-muted)]">
            {row.scope}
            {context ? ` · ${context}` : ''}
          </p>
        </div>

        <time
          dateTime={row.createdAt}
          title={formatFull(row.createdAt)}
          className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums"
        >
          {formatAge(row.createdAt)}
        </time>
      </div>

      {row.stack ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            Stack trace
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 font-mono text-[0.68rem] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
            {row.stack}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/** Server-side faults. Written by the logger, pruned by the maintenance sweep. */
export function ErrorsPanel(): React.JSX.Element {
  const [filter, setFilter] = React.useState<string>(ALL);
  const errors = useErrorLog(filter === ALL ? undefined : filter);
  const summary = useErrorSummary();

  const rows = React.useMemo(
    () => errors.data?.pages.flatMap((page) => page.items) ?? [],
    [errors.data],
  );

  const counts = new Map(summary.data?.bySeverity.map((row) => [row.severity, row.count]) ?? []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Last 24h"
          value={(summary.data?.last24h ?? 0).toLocaleString()}
          icon={<AlertTriangle />}
          tone={(summary.data?.last24h ?? 0) > 0 ? 'warning' : 'positive'}
          hint={
            summary.data?.latestAt ? `latest ${formatAge(summary.data.latestAt)}` : 'nothing yet'
          }
        />
        <StatCard label="Warnings" value={(counts.get('WARN') ?? 0).toLocaleString()} />
        <StatCard
          label="Errors"
          value={(counts.get('ERROR') ?? 0).toLocaleString()}
          icon={<Bug />}
          tone="danger"
        />
        <StatCard
          label="Fatal"
          value={(counts.get('FATAL') ?? 0).toLocaleString()}
          icon={<Flame />}
          tone={(counts.get('FATAL') ?? 0) > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {summary.data && summary.data.topScopes.length > 0 ? (
        <AdminPanel title="Noisiest scopes" description="Where the last day's faults came from.">
          <ul className="divide-y divide-[var(--hairline)]">
            {summary.data.topScopes.map((scope) => (
              <li
                key={scope.scope}
                className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
              >
                <span className="truncate font-mono text-xs text-[var(--text-secondary)]">
                  {scope.scope}
                </span>
                <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                  {scope.count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </AdminPanel>
      ) : null}

      <AdminPanel
        title="Error log"
        description="Faults raised by the server, newest first. Contexts are redacted before they are stored."
        action={
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-40" aria-label="Filter by severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All severities</SelectItem>
              {SEVERITIES.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {severity.toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {errors.isLoading ? (
          <RowsSkeleton rows={5} />
        ) : errors.error ? (
          <PanelError error={errors.error} />
        ) : rows.length > 0 ? (
          <>
            <ul className="divide-y divide-[var(--hairline)]">
              {rows.map((row) => (
                <ErrorRow key={row.id} row={row} />
              ))}
            </ul>

            {errors.hasNextPage ? (
              <div className="flex justify-center border-t border-[var(--hairline)] px-5 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={errors.isFetchingNextPage}
                  onClick={() => void errors.fetchNextPage()}
                >
                  Load older entries
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="px-5 py-6">
            <EmptyState
              title="Nothing has gone wrong"
              description="No server-side faults have been recorded."
            />
          </div>
        )}
      </AdminPanel>
    </div>
  );
}
