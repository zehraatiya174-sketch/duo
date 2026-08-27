'use client';

import * as React from 'react';

import { useSystemHealth } from '@/hooks/use-admin';
import { formatUptime } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatusDot } from './admin-shell';

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <span className="text-sm text-[var(--text-muted)]">{label}</span>
      <span className="text-sm font-medium text-[var(--text-primary)] tabular-nums">
        {children}
      </span>
    </div>
  );
}

/**
 * Live process health.
 *
 * The figures that matter on a small free-tier container: whether the database
 * answers and how fast, how many sockets are open, and heap usage — the last
 * being the one that actually kills this app, since a 512 MB instance running a
 * long-lived Node process has no headroom to spare.
 */
export function HealthPanel(): React.JSX.Element {
  const health = useSystemHealth();

  if (health.isLoading) return <RowsSkeleton rows={5} />;
  if (health.error) return <PanelError error={health.error} />;
  if (!health.data) return <RowsSkeleton rows={5} />;

  const data = health.data;
  const dbTone = !data.database.ok ? 'danger' : data.database.latencyMs > 300 ? 'warning' : 'positive';

  return (
    <AdminPanel
      title="System"
      description="Live state of the running process."
      action={
        <StatusDot
          tone={data.status === 'healthy' ? 'positive' : 'danger'}
          label={data.status === 'healthy' ? 'Healthy' : 'Degraded'}
          pulse={data.status === 'healthy'}
        />
      }
    >
      <div className="divide-y divide-[var(--hairline)]">
        <Row label="Database">
          <StatusDot
            tone={dbTone}
            label={data.database.ok ? `${data.database.latencyMs} ms` : 'Unreachable'}
          />
        </Row>
        <Row label="Uptime">{formatUptime(data.uptimeSeconds)}</Row>
        <Row label="Connections">{data.socket.connections}</Row>
        <Row label="Online">{data.socket.onlineUsers}</Row>
        <Row label="Heap">
          {data.memory.heapUsedMb} / {data.memory.heapTotalMb} MB
        </Row>
        <Row label="RSS">{data.memory.rssMb} MB</Row>
        <Row label="Node">{data.nodeVersion}</Row>
        <Row label="Environment">{data.environment}</Row>
      </div>

      {data.database.error ? (
        <p className="border-t border-[var(--hairline)] px-5 py-3 text-xs text-[var(--color-danger)]">
          {data.database.error}
        </p>
      ) : null}
    </AdminPanel>
  );
}
