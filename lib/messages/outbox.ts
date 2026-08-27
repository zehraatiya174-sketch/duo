import { createLogger } from '@/lib/logger';
import type { SendMessagePayload } from '@/types/socket';

const log = createLogger('outbox');

const STORAGE_KEY = 'duo.outbox.v1';

/**
 * A queue this long means something is badly wrong — a wedged connection, or a
 * loop. Dropping the oldest is better than growing until `localStorage` throws,
 * which would take the whole send path down with it.
 */
const MAX_ENTRIES = 200;

export interface OutboxEntry {
  payload: SendMessagePayload;
  queuedAt: string;
  attempts: number;
  lastError: string | null;
}

/**
 * Messages written but not yet acknowledged, persisted across reloads.
 *
 * This is the difference between "your message failed" and losing it: a tab
 * closed mid-send still has the payload on next open, and `useMessageSender`
 * drains the queue whenever the socket reconnects.
 *
 * `localStorage` rather than IndexedDB on purpose — the queue is tiny, and a
 * synchronous read means the composer knows what is outstanding on its first
 * render instead of a frame later.
 */
function isAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readOutbox(): OutboxEntry[] {
  if (!isAvailable()) return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Anything malformed is discarded rather than repaired: a half-valid payload
    // would be sent to the server and rejected on every drain.
    return parsed.filter((entry): entry is OutboxEntry => {
      if (typeof entry !== 'object' || entry === null) return false;
      const candidate = entry as Partial<OutboxEntry>;
      return (
        typeof candidate.payload === 'object' &&
        candidate.payload !== null &&
        typeof candidate.payload.clientId === 'string' &&
        typeof candidate.payload.chatId === 'string'
      );
    });
  } catch (error) {
    log.warn('Outbox unreadable; starting empty', { error });
    return [];
  }
}

function write(entries: OutboxEntry[]): OutboxEntry[] {
  if (!isAvailable()) return entries;

  const trimmed = entries.slice(-MAX_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    // Quota exceeded, or storage disabled in a private window. The send still
    // proceeds in memory; only durability across reloads is lost.
    log.warn('Could not persist the outbox', { error });
  }
  return trimmed;
}

/** Adds a payload, replacing any existing entry with the same `clientId`. */
export function enqueue(payload: SendMessagePayload): OutboxEntry[] {
  const existing = readOutbox().filter((entry) => entry.payload.clientId !== payload.clientId);
  return write([
    ...existing,
    { payload, queuedAt: new Date().toISOString(), attempts: 0, lastError: null },
  ]);
}

/** Removes an entry once the server has acknowledged it, or it is discarded. */
export function dequeue(clientId: string): OutboxEntry[] {
  return write(readOutbox().filter((entry) => entry.payload.clientId !== clientId));
}

/**
 * Records a failed attempt. The entry deliberately stays queued — the whole
 * point is that a failure is retryable, on reconnect or by hand.
 */
export function markAttempt(clientId: string, error: string): OutboxEntry[] {
  return write(
    readOutbox().map((entry) =>
      entry.payload.clientId === clientId
        ? { ...entry, attempts: entry.attempts + 1, lastError: error }
        : entry,
    ),
  );
}

export function clearOutbox(): OutboxEntry[] {
  return write([]);
}
