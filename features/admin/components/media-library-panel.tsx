'use client';

import { File, FileArchive, Image as ImageIcon, Mic, Video } from 'lucide-react';
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
import { useMediaLibrary, useMediaSummary } from '@/hooks/use-admin';
import { cn } from '@/lib/utils';
import type { MediaLibraryRow, MediaState } from '@/services/media-library';
import { formatAge, formatBytes, formatDuration, formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatCard, type StatusTone } from './admin-shell';

const ALL = 'ALL';

const GROUPS = [
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'documents', label: 'Documents' },
  { value: 'voice', label: 'Voice notes' },
  { value: 'other', label: 'Other' },
] as const;

const STATES: Array<{ value: MediaState; label: string }> = [
  { value: 'stored', label: 'Stored' },
  { value: 'disappearing', label: 'Disappearing' },
  { value: 'expired', label: 'Expired' },
  { value: 'purged', label: 'Purged' },
  { value: 'orphaned', label: 'Orphaned' },
];

const STATE_LABEL: Record<MediaState, string> = {
  stored: 'Stored',
  disappearing: 'Disappearing',
  expired: 'Expired',
  purged: 'Purged',
  orphaned: 'Orphaned',
};

const STATE_TONE: Record<MediaState, StatusTone> = {
  stored: 'neutral',
  disappearing: 'warning',
  expired: 'warning',
  purged: 'neutral',
  orphaned: 'danger',
};

const TONE_CHIP: Record<StatusTone, string> = {
  positive:
    'bg-[color-mix(in_oklch,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]',
  warning:
    'bg-[color-mix(in_oklch,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]',
  danger: 'bg-[color-mix(in_oklch,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
};

function KindIcon({ kind }: { kind: string }): React.JSX.Element {
  switch (kind) {
    case 'IMAGE':
    case 'GIF':
    case 'STICKER':
      return <ImageIcon aria-hidden />;
    case 'VIDEO':
      return <Video aria-hidden />;
    case 'VOICE_NOTE':
    case 'AUDIO':
      return <Mic aria-hidden />;
    case 'ARCHIVE':
      return <FileArchive aria-hidden />;
    default:
      return <File aria-hidden />;
  }
}

/**
 * One entry.
 *
 * The primary line is the file name where there is one to show, and the kind
 * where there is not: an ephemeral attachment's name is withheld by the service,
 * because a file name describes the contents of a private conversation.
 */
function MediaRow({ row }: { row: MediaLibraryRow }): React.JSX.Element {
  const tone = STATE_TONE[row.state];

  const details = [
    row.mimeType,
    row.provider,
    row.width && row.height ? `${row.width}×${row.height}` : null,
    row.durationSec ? formatDuration(row.durationSec) : null,
    row.encrypted ? 'encrypted' : null,
  ].filter(Boolean);

  const timing =
    row.state === 'purged' && row.purgedAt
      ? `purged ${formatAge(row.purgedAt)}`
      : row.expiresAt
        ? row.state === 'expired'
          ? `expired ${formatAge(row.expiresAt)}`
          : `expires ${formatAge(row.expiresAt)}`
        : null;

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="mt-0.5 shrink-0 text-[var(--text-muted)] [&_svg]:size-4">
        <KindIcon kind={row.kind} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={cn(
              'truncate',
              row.fileName
                ? 'font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] italic',
            )}
          >
            {row.fileName ?? `${row.kind.toLowerCase().replace('_', ' ')} · name withheld`}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase',
              TONE_CHIP[tone],
            )}
          >
            {STATE_LABEL[row.state]}
          </span>
        </p>
        <p className="truncate text-xs text-[var(--text-muted)]">
          {row.uploaderEmail}
          {details.length > 0 ? ` · ${details.join(' · ')}` : ''}
          {timing ? ` · ${timing}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-[var(--text-muted)] tabular-nums">
        <span>{formatBytes(row.byteSize)}</span>
        <time dateTime={row.uploadedAt} title={formatFull(row.uploadedAt)}>
          {formatAge(row.uploadedAt)}
        </time>
      </div>
    </li>
  );
}

/**
 * The media library.
 *
 * Deliberately metadata-only: upload time, size, provider and expiration state,
 * with no URL, thumbnail or preview anywhere in the response. It answers "what
 * is occupying storage" without becoming a window into either account's chat.
 */
export function MediaLibraryPanel(): React.JSX.Element {
  const [group, setGroup] = React.useState<string>(ALL);
  const [state, setState] = React.useState<string>(ALL);

  const library = useMediaLibrary({
    ...(group === ALL ? {} : { group }),
    ...(state === ALL ? {} : { state }),
  });
  const summary = useMediaSummary();

  const rows = React.useMemo(
    () => library.data?.pages.flatMap((page) => page.items) ?? [],
    [library.data],
  );

  const byGroup = new Map(summary.data?.groups.map((row) => [row.group, row]) ?? []);
  const byState = new Map(summary.data?.states.map((row) => [row.state, row]) ?? []);
  const disappearing =
    (byState.get('disappearing')?.count ?? 0) + (byState.get('expired')?.count ?? 0);
  const disappearingBytes =
    (byState.get('disappearing')?.bytes ?? 0) + (byState.get('expired')?.bytes ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Photos"
          value={(byGroup.get('photos')?.count ?? 0).toLocaleString()}
          icon={<ImageIcon />}
          hint={formatBytes(byGroup.get('photos')?.bytes ?? 0)}
        />
        <StatCard
          label="Videos"
          value={(byGroup.get('videos')?.count ?? 0).toLocaleString()}
          icon={<Video />}
          hint={formatBytes(byGroup.get('videos')?.bytes ?? 0)}
        />
        <StatCard
          label="Documents"
          value={(byGroup.get('documents')?.count ?? 0).toLocaleString()}
          icon={<File />}
          hint={formatBytes(byGroup.get('documents')?.bytes ?? 0)}
        />
        <StatCard
          label="Voice notes"
          value={(byGroup.get('voice')?.count ?? 0).toLocaleString()}
          icon={<Mic />}
          hint={formatBytes(byGroup.get('voice')?.bytes ?? 0)}
        />
      </div>

      <AdminPanel
        title="Storage by state"
        description="What each entry is doing to the disk right now."
      >
        <ul className="divide-y divide-[var(--hairline)]">
          {STATES.map(({ value, label }) => {
            const row = byState.get(value);
            return (
              <li
                key={value}
                className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
              >
                <span className="text-[var(--text-primary)]">{label}</span>
                <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                  {(row?.count ?? 0).toLocaleString()} · {formatBytes(row?.bytes ?? 0)}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-[var(--hairline)] px-5 py-3 text-xs text-[var(--text-muted)]">
          {disappearing.toLocaleString()} disappearing{' '}
          {disappearing === 1 ? 'entry' : 'entries'} holding {formatBytes(disappearingBytes)}.
          Purged rows are tombstones: the blob is gone, the size is kept so the reclaim is legible.
        </p>
      </AdminPanel>

      <AdminPanel
        title="Library"
        description="Metadata only. No preview, thumbnail or link is served from here, and names are withheld for disappearing media."
        action={
          <div className="flex gap-2">
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger className="w-36" aria-label="Filter by type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All types</SelectItem>
                {GROUPS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={state} onValueChange={setState}>
              <SelectTrigger className="w-40" aria-label="Filter by state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any state</SelectItem>
                {STATES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {library.isLoading ? (
          <RowsSkeleton rows={6} />
        ) : library.error ? (
          <PanelError error={library.error} />
        ) : rows.length > 0 ? (
          <>
            <ul className="divide-y divide-[var(--hairline)]">
              {rows.map((row) => (
                <MediaRow key={row.id} row={row} />
              ))}
            </ul>

            {library.hasNextPage ? (
              <div className="flex justify-center border-t border-[var(--hairline)] px-5 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={library.isFetchingNextPage}
                  onClick={() => void library.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="px-5 py-6">
            <EmptyState
              title="Nothing here"
              description={
                group === ALL && state === ALL
                  ? 'No media has been uploaded yet.'
                  : 'No entries match those filters.'
              }
            />
          </div>
        )}
      </AdminPanel>
    </div>
  );
}
