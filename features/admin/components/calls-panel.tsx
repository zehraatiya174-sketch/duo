'use client';

import { Phone, PhoneMissed, Video } from 'lucide-react';
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
import { useCallLog, useCallStats } from '@/hooks/use-admin';
import { cn } from '@/lib/utils';
import type { AdminCallRow } from '@/services/admin';
import { formatAge, formatDuration, formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatCard, type StatusTone } from './admin-shell';

const ALL = 'ALL';

const STATUSES = ['RINGING', 'ONGOING', 'ENDED', 'MISSED', 'DECLINED', 'FAILED'] as const;

const STATUS_TONE: Record<string, StatusTone> = {
  RINGING: 'warning',
  ONGOING: 'positive',
  ENDED: 'neutral',
  MISSED: 'warning',
  DECLINED: 'neutral',
  FAILED: 'danger',
};

const TONE_TEXT: Record<StatusTone, string> = {
  positive: 'text-[var(--color-positive)]',
  warning: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]',
  neutral: 'text-[var(--text-muted)]',
};

function CallRow({ call }: { call: AdminCallRow }): React.JSX.Element {
  const tone = STATUS_TONE[call.status] ?? 'neutral';
  const failed = call.status === 'MISSED' || call.status === 'FAILED';

  // Round trip and loss are what tell a bad call from a short one.
  const link = call.quality
    ? [
        call.quality.transport,
        call.quality.rttMs !== null ? `${Math.round(call.quality.rttMs)}ms rtt` : null,
        call.quality.lossRatio !== null
          ? `${(call.quality.lossRatio * 100).toFixed(1)}% loss`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', TONE_TEXT[tone])}>
        {failed ? (
          <PhoneMissed aria-hidden />
        ) : call.kind === 'VIDEO' ? (
          <Video aria-hidden />
        ) : (
          <Phone aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)]">
          <span className="font-medium">{call.kind === 'VIDEO' ? 'Video' : 'Voice'}</span>
          <span className={cn('ml-2 text-xs', TONE_TEXT[tone])}>{call.status.toLowerCase()}</span>
          {call.durationSec ? (
            <span className="ml-2 text-xs text-[var(--text-muted)] tabular-nums">
              {formatDuration(call.durationSec)}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-[var(--text-muted)]">
          from {call.initiatorEmail}
          {call.endReason ? ` · ${call.endReason}` : ''}
          {link ? ` · ${link}` : ''}
        </p>
      </div>

      <time
        dateTime={call.startedAt}
        title={formatFull(call.startedAt)}
        className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums"
      >
        {formatAge(call.startedAt)}
      </time>
    </li>
  );
}

/**
 * The call log.
 *
 * Only the envelope of each call is stored — who rang, when, for how long, and
 * how the link behaved — so this pane can be read without it being a window
 * into anybody's conversation.
 */
export function CallsPanel(): React.JSX.Element {
  const [filter, setFilter] = React.useState<string>(ALL);
  const calls = useCallLog(filter === ALL ? undefined : filter);
  const stats = useCallStats();

  const rows = React.useMemo(
    () => calls.data?.pages.flatMap((page) => page.items) ?? [],
    [calls.data],
  );

  const summary = stats.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Calls" value={(summary?.total ?? 0).toLocaleString()} icon={<Phone />} />
        <StatCard
          label="Answered"
          value={(summary?.answered ?? 0).toLocaleString()}
          hint={
            summary && summary.total > 0
              ? `${Math.round((summary.answered / summary.total) * 100)}% of attempts`
              : undefined
          }
          tone="positive"
        />
        <StatCard
          label="Talk time"
          value={`${(summary?.totalMinutes ?? 0).toLocaleString()}m`}
          hint={
            summary && summary.averageDurationSec > 0
              ? `${formatDuration(summary.averageDurationSec)} average`
              : undefined
          }
        />
        <StatCard
          label="Relayed"
          value={
            summary?.relayShare === null || summary?.relayShare === undefined
              ? '—'
              : `${Math.round(summary.relayShare * 100)}%`
          }
          hint="Calls that needed TURN"
          tone={summary?.relayShare !== null && (summary?.relayShare ?? 0) > 0.5 ? 'warning' : 'neutral'}
        />
      </div>

      <AdminPanel
        title="Call log"
        description="Connection outcomes, newest first. No call is recorded — only its envelope."
        action={
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-44" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All calls</SelectItem>
              {STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status.toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {calls.isLoading ? (
          <RowsSkeleton rows={5} />
        ) : calls.error ? (
          <PanelError error={calls.error} />
        ) : rows.length > 0 ? (
          <>
            <ul className="divide-y divide-[var(--hairline)]">
              {rows.map((call) => (
                <CallRow key={call.id} call={call} />
              ))}
            </ul>

            {calls.hasNextPage ? (
              <div className="flex justify-center border-t border-[var(--hairline)] px-5 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={calls.isFetchingNextPage}
                  onClick={() => void calls.fetchNextPage()}
                >
                  Load older calls
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="px-5 py-6">
            <EmptyState
              title="No calls"
              description={
                filter === ALL
                  ? 'Nobody has placed a call yet.'
                  : 'No calls with that outcome have been recorded.'
              }
            />
          </div>
        )}
      </AdminPanel>
    </div>
  );
}
