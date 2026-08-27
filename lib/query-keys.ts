/**
 * Every TanStack Query key in one place.
 *
 * Keys are built by these factories rather than written inline so that a
 * targeted `invalidateQueries` cannot miss a cache entry because two call sites
 * spelled the same key slightly differently.
 */

import type { SearchMessagesInput } from '@/lib/validation/message';

export const queryKeys = {
  chat: () => ['chat'] as const,
  participants: () => ['participants'] as const,
  profile: () => ['profile'] as const,
  settings: () => ['settings'] as const,

  /**
   * The `messages` prefix is shared by the timeline, jump-to-message windows and
   * search results because all three hold `Page<MessageDTO>` and all three must
   * receive the same realtime patches. Anything with a different shape — pinned
   * messages, for one — is deliberately kept outside this prefix.
   */
  messages: (chatId: string) => ['messages', chatId] as const,
  messagesAround: (chatId: string, messageId: string) =>
    ['messages', chatId, 'around', messageId] as const,
  search: (chatId: string, filters: Partial<SearchMessagesInput>) =>
    ['messages', chatId, 'search', filters] as const,

  pinned: (chatId: string) => ['pinned', chatId] as const,

  sharedMedia: (chatId: string, kind: string) => ['shared-media', chatId, kind] as const,
  sharedMediaCounts: (chatId: string) => ['shared-media', chatId, 'counts'] as const,
  sharedLinks: (chatId: string) => ['shared-media', chatId, 'links'] as const,

  gifs: (kind: string, query: string) => ['gifs', kind, query] as const,

  notifications: () => ['notifications'] as const,
  devices: () => ['devices'] as const,
  calls: () => ['calls'] as const,
  iceServers: () => ['calls', 'ice-servers'] as const,

  admin: {
    /** Prefix for the console's "refresh everything" control. */
    all: () => ['admin'] as const,
    overview: () => ['admin', 'overview'] as const,
    health: () => ['admin', 'health'] as const,
    sessions: () => ['admin', 'sessions'] as const,
    storage: () => ['admin', 'storage'] as const,
    users: () => ['admin', 'users'] as const,
    settings: () => ['admin', 'settings'] as const,
    devices: () => ['admin', 'devices'] as const,
    database: () => ['admin', 'database'] as const,
    uploads: () => ['admin', 'uploads'] as const,
    analytics: () => ['admin', 'analytics'] as const,
    callStats: () => ['admin', 'calls', 'stats'] as const,
    calls: (filters: Record<string, string | undefined>) => ['admin', 'calls', filters] as const,
    errorSummary: () => ['admin', 'errors', 'summary'] as const,
    errors: (filters: Record<string, string | undefined>) => ['admin', 'errors', filters] as const,
    mediaSummary: () => ['admin', 'media', 'summary'] as const,
    media: (filters: Record<string, string | undefined>) => ['admin', 'media', filters] as const,
    audit: (filters: Record<string, string | undefined>) => ['admin', 'audit', filters] as const,
  },
} as const;
