'use client';

import { HardDrive, Timer, Trash2, Upload } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { useUploadStats } from '@/hooks/use-admin';
import { formatBytes } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatCard } from './admin-shell';

const KIND_LABEL: Record<string, string> = {
  IMAGE: 'Images',
  VIDEO: 'Videos',
  AUDIO: 'Audio',
  VOICE_NOTE: 'Voice notes',
  DOCUMENT: 'Documents',
  ARCHIVE: 'Archives',
  GIF: 'GIFs',
  STICKER: 'Stickers',
  OTHER: 'Other',
};

/** A bar chart thin enough to sit inside a list row. */
function Sparkline({ series }: { series: Array<{ date: string; uploads: number }> }): React.JSX.Element {
  const peak = Math.max(1, ...series.map((point) => point.uploads));

  return (
    <div className="flex h-16 items-end gap-1" role="img" aria-label="Uploads per day, last fourteen days">
      {series.map((point) => (
        <div
          key={point.date}
          title={`${point.date}: ${point.uploads}`}
          className="flex-1 rounded-t-sm bg-[var(--accent)] transition-[height] duration-500"
          // A zero day still gets a hairline, so the axis reads as fourteen days.
          style={{ height: `${Math.max((point.uploads / peak) * 100, 2)}%` }}
        />
      ))}
    </div>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; count: number; bytes: number }>;
}): React.JSX.Element {
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);

  return (
    <AdminPanel title={title}>
      {rows.length > 0 ? (
        <ul className="divide-y divide-[var(--hairline)]">
          {[...rows]
            .sort((a, b) => b.bytes - a.bytes)
            .map((row) => {
              const share = total > 0 ? row.bytes / total : 0;
              return (
                <li key={row.label} className="px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate font-medium text-[var(--text-primary)]">
                      {row.label}
                    </span>
                    <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                      {row.count.toLocaleString()} · {formatBytes(row.bytes)}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
                      style={{ width: `${Math.max(share * 100, 1)}%` }}
                    />
                  </div>
                </li>
              );
            })}
        </ul>
      ) : (
        <div className="px-5 py-6">
          <EmptyState title="Nothing yet" description="No uploads have been recorded." />
        </div>
      )}
    </AdminPanel>
  );
}

/**
 * Upload statistics.
 *
 * Counts and bytes, sliced by kind, provider and uploader. Nothing here reads
 * an object — only the metadata rows that describe them.
 */
export function UploadsPanel(): React.JSX.Element {
  const uploads = useUploadStats();
  const data = uploads.data;

  if (uploads.isLoading) {
    return (
      <AdminPanel title="Uploads">
        <RowsSkeleton rows={5} />
      </AdminPanel>
    );
  }

  if (uploads.error) {
    return (
      <AdminPanel title="Uploads">
        <PanelError error={uploads.error} />
      </AdminPanel>
    );
  }

  if (!data) return <></>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Uploads"
          value={data.total.toLocaleString()}
          icon={<Upload />}
          hint={`${formatBytes(data.averageBytes)} average`}
        />
        <StatCard
          label="Stored"
          value={formatBytes(data.totalBytes)}
          icon={<HardDrive />}
          hint={`largest ${formatBytes(data.largestBytes)}`}
        />
        <StatCard
          label="Disappearing"
          value={data.ephemeral.toLocaleString()}
          icon={<Timer />}
          tone="warning"
          hint={`${data.purged.toLocaleString()} already purged`}
        />
        <StatCard
          label="Orphaned"
          value={data.orphaned.toLocaleString()}
          icon={<Trash2 />}
          tone={data.orphaned > 0 ? 'warning' : 'neutral'}
          hint="Never attached to a message"
        />
      </div>

      <AdminPanel title="Upload volume" description="Files accepted per day, last fourteen days.">
        <div className="px-5 py-4">
          <Sparkline series={data.last14Days} />
          <div className="mt-2 flex justify-between text-[0.68rem] text-[var(--text-muted)]">
            <span>{data.last14Days[0]?.date ?? ''}</span>
            <span>{data.last14Days.at(-1)?.date ?? ''}</span>
          </div>
        </div>
      </AdminPanel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="By type"
          rows={data.byKind.map((row) => ({
            label: KIND_LABEL[row.kind] ?? row.kind,
            count: row.count,
            bytes: row.bytes,
          }))}
        />
        <Breakdown
          title="By provider"
          rows={data.byProvider.map((row) => ({
            label: row.provider,
            count: row.count,
            bytes: row.bytes,
          }))}
        />
      </div>

      <Breakdown
        title="By uploader"
        rows={data.byUploader.map((row) => ({
          label: row.email,
          count: row.count,
          bytes: row.bytes,
        }))}
      />
    </div>
  );
}
