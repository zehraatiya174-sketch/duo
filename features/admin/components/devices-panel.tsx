'use client';

import { Laptop, Monitor, Smartphone, Tablet } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { useAdminDevices } from '@/hooks/use-admin';
import type { AdminDeviceRow } from '@/services/admin';
import { formatAge, formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatusDot } from './admin-shell';

/** Falls back to a desktop glyph: an unknown device is most often a browser. */
function DeviceIcon({ type }: { type: string | null }): React.JSX.Element {
  const normalised = type?.toLowerCase() ?? '';
  if (normalised.includes('mobile') || normalised.includes('phone')) {
    return <Smartphone aria-hidden />;
  }
  if (normalised.includes('tablet')) return <Tablet aria-hidden />;
  if (normalised.includes('laptop')) return <Laptop aria-hidden />;
  return <Monitor aria-hidden />;
}

function DeviceRow({ device }: { device: AdminDeviceRow }): React.JSX.Element {
  const details = [device.browser, device.os, device.location].filter(Boolean).join(' · ');

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="mt-0.5 shrink-0 text-[var(--text-muted)] [&_svg]:size-4">
        <DeviceIcon type={device.deviceType} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">
          {device.label}
          {device.trusted ? (
            <span className="ml-2 rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
              Trusted
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-[var(--text-muted)]">
          {device.userEmail}
          {details ? ` · ${details}` : ''}
          {device.ipAddress ? ` · ${device.ipAddress}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {device.sessionActive ? (
          <StatusDot
            tone={device.online ? 'positive' : 'neutral'}
            label={device.online ? 'Connected' : 'Signed in'}
            pulse={device.online}
          />
        ) : (
          <StatusDot tone="neutral" label="Signed out" />
        )}
        <time
          dateTime={device.lastActiveAt}
          title={formatFull(device.lastActiveAt)}
          className="text-xs text-[var(--text-muted)] tabular-nums"
        >
          {formatAge(device.lastActiveAt)}
        </time>
      </div>
    </li>
  );
}

/**
 * Connected devices.
 *
 * "Connected" is deliberately three states, not two: a device can hold a live
 * session without a socket open, and telling that apart from a device that was
 * signed out is the difference between a stale row and an intruder.
 */
export function DevicesPanel(): React.JSX.Element {
  const devices = useAdminDevices();
  const rows = devices.data ?? [];
  const live = rows.filter((device) => device.sessionActive).length;

  return (
    <AdminPanel
      title="Devices"
      description={
        devices.data
          ? `${rows.length} known · ${live} with a live session`
          : 'Every device either account has signed in from.'
      }
    >
      {devices.isLoading ? (
        <RowsSkeleton rows={4} />
      ) : devices.error ? (
        <PanelError error={devices.error} />
      ) : rows.length > 0 ? (
        <ul className="divide-y divide-[var(--hairline)]">
          {rows.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      ) : (
        <div className="px-5 py-6">
          <EmptyState
            title="No devices"
            description="Nothing has signed in to this deployment yet."
          />
        </div>
      )}
    </AdminPanel>
  );
}
