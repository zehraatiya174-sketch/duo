'use client';

import { MessageSquare, Pencil, Smile, Timer } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { useSystemAnalytics } from '@/hooks/use-admin';
import { cn } from '@/lib/utils';

import { AdminPanel, PanelError, RowsSkeleton, StatCard } from './admin-shell';

const MESSAGE_TYPE_LABEL: Record<string, string> = {
  TEXT: 'Text',
  IMAGE: 'Images',
  VIDEO: 'Videos',
  AUDIO: 'Audio',
  VOICE_NOTE: 'Voice notes',
  DOCUMENT: 'Documents',
  STICKER: 'Stickers',
  GIF: 'GIFs',
  LOCATION: 'Location',
  CONTACT: 'Contacts',
  SYSTEM: 'System',
  CALL: 'Calls',
};

/** `2026-07-31` → `31 Jul`, without pulling a formatter in for one label. */
function shortDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

type Stream = 'messages' | 'calls' | 'uploads';

const STREAM_COLOR: Record<Stream, string> = {
  messages: 'bg-[var(--accent)]',
  calls: 'bg-[var(--color-positive)]',
  uploads: 'bg-[var(--color-warning)]',
};

/**
 * Three streams stacked on one axis.
 *
 * Stacked rather than overlaid: the question this pane answers is "how busy was
 * the deployment", and a stack reads as one height per day.
 */
function ActivityChart({
  series,
}: {
  series: Array<{ date: string; messages: number; calls: number; uploads: number }>;
}): React.JSX.Element {
  const peak = Math.max(1, ...series.map((day) => day.messages + day.calls + day.uploads));

  return (
    <div>
      <div className="flex h-40 items-end gap-1.5">
        {series.map((day) => {
          const total = day.messages + day.calls + day.uploads;
          return (
            <div
              key={day.date}
              className="flex flex-1 flex-col justify-end gap-px"
              title={`${shortDate(day.date)} · ${day.messages} messages · ${day.calls} calls · ${day.uploads} uploads`}
            >
              {(['uploads', 'calls', 'messages'] as const).map((stream) =>
                day[stream] > 0 ? (
                  <div
                    key={stream}
                    className={cn('rounded-sm transition-[height] duration-500', STREAM_COLOR[stream])}
                    style={{ height: `${Math.max((day[stream] / peak) * 100, 1.5)}%` }}
                  />
                ) : null,
              )}
              {total === 0 ? (
                <div className="h-px rounded-sm bg-[var(--hairline)]" />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex justify-between text-[0.68rem] text-[var(--text-muted)]">
        <span>{series[0] ? shortDate(series[0].date) : ''}</span>
        <span>{series.at(-1) ? shortDate(series.at(-1)!.date) : ''}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
        {(['messages', 'calls', 'uploads'] as const).map((stream) => (
          <span key={stream} className="inline-flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', STREAM_COLOR[stream])} aria-hidden />
            {stream}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Hour-of-day histogram. Labelled UTC because that is what the rows carry. */
function HourChart({ byHour }: { byHour: Array<{ hour: number; messages: number }> }): React.JSX.Element {
  const peak = Math.max(1, ...byHour.map((row) => row.messages));

  return (
    <div>
      <div className="flex h-24 items-end gap-px">
        {byHour.map((row) => (
          <div
            key={row.hour}
            title={`${String(row.hour).padStart(2, '0')}:00 UTC · ${row.messages} messages`}
            className="flex-1 rounded-t-sm bg-[var(--accent)] transition-[height] duration-500"
            style={{ height: `${Math.max((row.messages / peak) * 100, 1.5)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[0.68rem] text-[var(--text-muted)]">
        <span>00:00</span>
        <span>12:00</span>
        <span>23:00</span>
      </div>
    </div>
  );
}

/** System analytics: fourteen days of activity, and how it splits. */
export function AnalyticsPanel(): React.JSX.Element {
  const analytics = useSystemAnalytics();
  const data = analytics.data;

  if (analytics.isLoading) {
    return (
      <AdminPanel title="Analytics">
        <RowsSkeleton rows={6} />
      </AdminPanel>
    );
  }

  if (analytics.error) {
    return (
      <AdminPanel title="Analytics">
        <PanelError error={analytics.error} />
      </AdminPanel>
    );
  }

  if (!data) return <></>;

  const typeTotal = data.messagesByType.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Messages"
          value={data.totals.messages.toLocaleString()}
          icon={<MessageSquare />}
          hint={`${data.totals.messagesLast14Days.toLocaleString()} in the last 14 days`}
        />
        <StatCard
          label="Reactions"
          value={data.totals.reactions.toLocaleString()}
          icon={<Smile />}
        />
        <StatCard
          label="Edited"
          value={data.totals.edited.toLocaleString()}
          icon={<Pencil />}
          hint={`${data.totals.deleted.toLocaleString()} deleted`}
        />
        <StatCard
          label="Disappearing"
          value={data.totals.ephemeral.toLocaleString()}
          icon={<Timer />}
          tone="warning"
          hint={
            data.totals.hidden > 0
              ? `${data.totals.hidden.toLocaleString()} hidden by the watermark`
              : 'none hidden'
          }
        />
      </div>

      <AdminPanel
        title="Activity"
        description="Messages, calls and uploads per day over the last fourteen days."
      >
        <div className="px-5 py-4">
          <ActivityChart series={data.series} />
        </div>
      </AdminPanel>

      <div className="grid gap-4 lg:grid-cols-2">
        <AdminPanel title="Message types" description="What the last fourteen days were made of.">
          {data.messagesByType.length > 0 ? (
            <ul className="divide-y divide-[var(--hairline)]">
              {[...data.messagesByType]
                .sort((a, b) => b.count - a.count)
                .map((row) => {
                  const share = typeTotal > 0 ? row.count / typeTotal : 0;
                  return (
                    <li key={row.type} className="px-5 py-3">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-medium text-[var(--text-primary)]">
                          {MESSAGE_TYPE_LABEL[row.type] ?? row.type}
                        </span>
                        <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                          {row.count.toLocaleString()} · {Math.round(share * 100)}%
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
              <EmptyState title="No messages" description="Nothing has been sent yet." />
            </div>
          )}
        </AdminPanel>

        <AdminPanel title="Busiest hours" description="Messages by hour of day, UTC.">
          <div className="px-5 py-4">
            <HourChart byHour={data.byHour} />
          </div>
        </AdminPanel>
      </div>

      <AdminPanel title="Per account" description="Lifetime totals for each of the two accounts.">
        <ul className="divide-y divide-[var(--hairline)]">
          {data.perUser.map((row) => (
            <li
              key={row.userId}
              className="flex items-baseline justify-between gap-3 px-5 py-3 text-sm"
            >
              <span className="truncate text-[var(--text-primary)]">{row.email}</span>
              <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                {row.messages.toLocaleString()} messages · {row.attachments.toLocaleString()} uploads
              </span>
            </li>
          ))}
        </ul>
      </AdminPanel>
    </div>
  );
}
