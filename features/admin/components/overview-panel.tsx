'use client';

import { Flame, HardDrive, Image as ImageIcon, MessageSquare, Phone, Users } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { useAdminOverview } from '@/hooks/use-admin';
import { formatBytes } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatCard } from './admin-shell';

/** Bar chart of the daily message counts. Deliberately axis-free. */
function ActivityChart({
  activity,
}: {
  activity: Array<{ date: string; messages: number }>;
}): React.JSX.Element {
  const peak = Math.max(1, ...activity.map((day) => day.messages));

  return (
    <div className="flex h-24 items-end gap-1 px-5 py-4">
      {activity.map((day) => (
        <div
          key={day.date}
          title={`${day.date}: ${day.messages}`}
          className="flex-1 rounded-t-[3px] bg-[var(--accent)] transition-opacity hover:opacity-80"
          // A day with no messages still gets a sliver, so the axis reads as a
          // continuous series rather than as a gap in the data.
          style={{ height: `${Math.max(2, (day.messages / peak) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * The admin console's landing tab: how much of everything exists.
 *
 * Counts only — nothing here reads a message body. The console is for the pair
 * who own the deployment, but "admin" is still one of the two people the other
 * is talking to, so it deliberately stops at metadata.
 */
export function OverviewPanel(): React.JSX.Element {
  const overview = useAdminOverview();

  if (overview.isLoading) return <RowsSkeleton rows={6} />;
  if (overview.error) return <PanelError error={overview.error} />;
  if (!overview.data) return <EmptyState title="No data" description="Nothing to report yet." />;

  const data = overview.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Accounts" value={data.users} icon={<Users />} />
        <StatCard label="Messages" value={data.messages.toLocaleString()} icon={<MessageSquare />} />
        <StatCard label="Attachments" value={data.attachments.toLocaleString()} icon={<ImageIcon />} />
        <StatCard label="Calls" value={data.calls.toLocaleString()} icon={<Phone />} />
        <StatCard
          label="Sealed pending"
          value={data.ephemeralPending}
          hint={`${data.ephemeralPurged.toLocaleString()} destroyed so far`}
          icon={<Flame />}
          tone={data.ephemeralPending > 0 ? 'warning' : 'neutral'}
        />
        <StatCard
          label="Storage"
          value={formatBytes(data.storage.trackedBytes)}
          hint={`${data.storage.attachmentCount.toLocaleString()} files · ${formatBytes(
            data.storage.quotaBytes,
          )} quota`}
          icon={<HardDrive />}
          tone={
            data.storage.trackedBytes > data.storage.quotaBytes * 0.9 ? 'warning' : 'neutral'
          }
        />
      </div>

      <AdminPanel title="Activity" description="Messages sent per day.">
        {data.activity.length === 0 ? (
          <EmptyState title="No activity" description="No messages have been sent yet." />
        ) : (
          <ActivityChart activity={data.activity} />
        )}
      </AdminPanel>
    </div>
  );
}
