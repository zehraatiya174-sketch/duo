import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import type { MessageDTO, Page } from '@/types/models';

/**
 * The shape every message-bearing cache holds.
 *
 * The timeline, jump-to-message windows and search results all store this, which
 * is why they share the `['messages', chatId]` prefix — one realtime event has
 * to patch whichever of them happen to be mounted.
 *
 * Pages are newest-first (`createdAt desc`), matching the query in
 * `services/messages.ts`; later pages are older.
 */
export type MessagePages = InfiniteData<Page<MessageDTO>>;

/** Optimistic rows are addressed by `clientId`; server rows by `id`. */
function matches(message: MessageDTO, key: string): boolean {
  return message.id === key || message.clientId === key;
}

function mapPages(
  data: MessagePages,
  fn: (items: MessageDTO[]) => MessageDTO[],
): MessagePages {
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: fn(page.items) })) };
}

/**
 * Inserts a message, or replaces the row it supersedes.
 *
 * The replacement is what closes the optimistic loop: the server's copy arrives
 * carrying the same `clientId` as the placeholder, so it overwrites in place
 * rather than appearing beneath it as a duplicate.
 */
export function upsertMessage(data: MessagePages, message: MessageDTO): MessagePages {
  const exists = data.pages.some((page) =>
    page.items.some(
      (item) => item.id === message.id || (item.clientId && item.clientId === message.clientId),
    ),
  );

  if (exists) {
    return mapPages(data, (items) =>
      items.map((item) =>
        item.id === message.id || (item.clientId && item.clientId === message.clientId)
          ? message
          : item,
      ),
    );
  }

  // A genuinely new message belongs at the head of the newest page. Inserting by
  // timestamp rather than unshifting keeps ordering correct when a message
  // arrives out of order after a reconnect replay.
  const [first, ...rest] = data.pages;
  if (!first) {
    return { ...data, pages: [{ items: [message], nextCursor: null, hasMore: false }] };
  }

  const items = [...first.items];
  const at = items.findIndex((item) => item.createdAt <= message.createdAt);
  if (at === -1) items.push(message);
  else items.splice(at, 0, message);

  return { ...data, pages: [{ ...first, items }, ...rest] };
}

/**
 * Updates whichever row matches `key`, leaving the rest alone.
 *
 * Accepts either a partial to merge or a function of the current row. The
 * function form exists for patches that depend on what is already there —
 * ephemeral counters, for one, where the new `remainingViews` only applies to
 * the viewer who opened it and the existing value has to be preserved otherwise.
 */
export function patchMessage(
  data: MessagePages,
  key: string,
  changes: Partial<MessageDTO> | ((current: MessageDTO) => MessageDTO),
): MessagePages {
  return mapPages(data, (items) =>
    items.map((item) => {
      if (!matches(item, key)) return item;
      return typeof changes === 'function' ? changes(item) : { ...item, ...changes };
    }),
  );
}

export function removeMessage(data: MessagePages, key: string): MessagePages {
  return mapPages(data, (items) => items.filter((item) => !matches(item, key)));
}

/**
 * Applies `updater` to every mounted message cache for one chat.
 *
 * `setQueriesData` with the shared prefix is deliberate: patching only the
 * timeline would leave a stale copy behind in an open search panel, and the two
 * would then disagree about whether a message was deleted.
 *
 * Caches that have not loaded yet are skipped rather than seeded — writing a
 * synthetic first page would make the query look fetched and suppress the real
 * request.
 */
export function updateAllMessageCaches(
  client: QueryClient,
  chatId: string,
  updater: (data: MessagePages) => MessagePages,
): void {
  client.setQueriesData<MessagePages>(
    { queryKey: queryKeys.messages(chatId) },
    (data) => (data ? updater(data) : data),
  );
}
