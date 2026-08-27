'use client';

import { Database, Gauge, Table2 } from 'lucide-react';
import * as React from 'react';

import { useDatabaseStatus } from '@/hooks/use-admin';
import { formatBytes } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatCard, StatusDot } from './admin-shell';

/** Over this, a round trip is worth noticing rather than merely reporting. */
const SLOW_QUERY_MS = 250;

export function DatabasePanel(): React.JSX.Element {
  const status = useDatabaseStatus();
  const data = status.data;

  const totalRows = data?.tables.reduce((sum, row) => sum + row.rows, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Connection"
          value={data ? (data.ok ? 'Up' : 'Down') : '—'}
          icon={<Database />}
          tone={data ? (data.ok ? 'positive' : 'danger') : 'neutral'}
          hint={data?.version ?? undefined}
        />
        <StatCard
          label="Latency"
          value={data ? `${Math.round(data.latencyMs)}ms` : '—'}
          icon={<Gauge />}
          tone={data && data.latencyMs > SLOW_QUERY_MS ? 'warning' : 'neutral'}
          hint="Round trip for a health probe"
        />
        <StatCard
          label="On disk"
          value={data?.sizeBytes === null || data?.sizeBytes === undefined ? '—' : formatBytes(data.sizeBytes)}
          hint="Reported by the engine"
        />
        <StatCard
          label="Rows"
          value={totalRows.toLocaleString()}
          icon={<Table2 />}
          hint={`across ${data?.tables.length ?? 0} tables`}
        />
      </div>

      <AdminPanel
        title="Tables"
        description="Row counts, largest first. Counts only — no table is read from here."
        action={
          data ? (
            <StatusDot
              tone={data.ok ? 'positive' : 'danger'}
              label={data.ok ? 'Reachable' : 'Unreachable'}
              pulse={data.ok}
            />
          ) : undefined
        }
      >
        {status.isLoading ? (
          <RowsSkeleton rows={6} />
        ) : status.error ? (
          <PanelError error={status.error} />
        ) : data && !data.ok ? (
          <p role="alert" className="px-5 py-6 text-sm text-[var(--color-danger)]">
            {data.error ?? 'The database did not answer.'}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--hairline)]">
            {[...(data?.tables ?? [])]
              .sort((a, b) => b.rows - a.rows)
              .map((row) => (
                <li
                  key={row.table}
                  className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
                >
                  <span className="font-mono text-xs text-[var(--text-secondary)]">{row.table}</span>
                  <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                    {row.rows.toLocaleString()}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </AdminPanel>
    </div>
  );
}
