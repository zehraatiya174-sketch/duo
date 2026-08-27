import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isSameDay,
  isThisYear,
  parseISO,
} from 'date-fns';

/**
 * Date and duration formatting for the conversation surface.
 *
 * Every wire timestamp is an ISO string, so each helper accepts either that or
 * a `Date` and normalises once, rather than making every call site remember.
 */

export function toDate(value: Date | string): Date {
  return typeof value === 'string' ? parseISO(value) : value;
}

/** `14:32` — the timestamp under a bubble. */
export function formatClock(value: Date | string): string {
  return format(toDate(value), 'HH:mm');
}

/** The label on a day separator: Today, Yesterday, a weekday, or a full date. */
export function formatDayLabel(value: Date | string): string {
  const date = toDate(value);
  const distance = differenceInCalendarDays(new Date(), date);

  if (distance === 0) return 'Today';
  if (distance === 1) return 'Yesterday';
  if (distance < 7) return format(date, 'EEEE');
  return isThisYear(date) ? format(date, 'd MMMM') : format(date, 'd MMMM yyyy');
}

/** Full timestamp for tooltips and message details. */
export function formatFull(value: Date | string): string {
  return format(toDate(value), "EEEE d MMMM yyyy 'at' HH:mm");
}

/** `last seen 4 minutes ago`, or `last seen just now` under a minute. */
export function formatLastSeen(value: Date | string | null): string {
  if (!value) return 'Last seen recently';
  const date = toDate(value);
  if (Date.now() - date.getTime() < 60_000) return 'Last seen just now';
  return `Last seen ${formatDistanceToNowStrict(date, { addSuffix: true })}`;
}

/**
 * `now`, `4m`, `3h`, `2d` — compact ages for dense lists.
 *
 * Deliberately abbreviated rather than "4 minutes ago": these sit at the end of
 * a row that already has a title and a body competing for the same width.
 */
export function formatAge(value: Date | string): string {
  const elapsed = Date.now() - toDate(value).getTime();
  if (elapsed < 60_000) return 'now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  return format(toDate(value), isThisYear(toDate(value)) ? 'd MMM' : 'd MMM yyyy');
}

/**
 * `just now`, `2m ago`, `3h ago`, `Yesterday` — the age half of a "Seen …" line.
 *
 * Deliberately coarser than `formatAge`: this reads as a sentence under the
 * last message rather than as a column in a list, so it spells out "ago" and
 * falls back to day names once an exact offset stops being meaningful.
 */
export function formatSeen(value: Date | string): string {
  const date = toDate(value);
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return 'just now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const days = differenceInCalendarDays(new Date(), date);
  if (days === 0) return `${Math.floor(minutes / 60)}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return format(date, 'EEEE');

  return isThisYear(date) ? format(date, 'd MMMM') : format(date, 'd MMMM yyyy');
}

/** True when two messages belong under the same day separator. */
export function isSameDayAs(a: Date | string, b: Date | string): boolean {
  return isSameDay(toDate(a), toDate(b));
}

/** `1:04` / `12:03:07` — for voice notes, videos and call durations. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Countdown text for a self-destruct timer, e.g. `4m 12s`. */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  if (total >= 86_400) return `${Math.floor(total / 86_400)}d`;
  if (total >= 3600) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${total}s`;
}

/**
 * `5d 3h` — process uptime.
 *
 * Distinct from `formatDuration`, which is a clock reading: `123:04:07` is the
 * right shape for a video's scrubber and the wrong one for "how long has this
 * been up".
 */
export function formatUptime(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3600);
  const minutes = Math.floor((safe % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${safe % 60}s`;
  return `${safe}s`;
}

/** `1.4 MB` — attachment sizes, storage totals. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}
