'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import type {
  AdminCallRow,
  AdminDeviceRow,
  AdminOverview,
  AdminSessionRow,
  AdminUserRow,
  AuditLogRow,
  CallStats,
  DatabaseStatus,
  SystemAnalytics,
  SystemHealth,
  UploadStats,
} from '@/services/admin';
import type { AppSettingsDTO } from '@/services/app-settings';
import type { ErrorLogRow, ErrorSummary } from '@/services/diagnostics';
import type { MediaLibraryRow, MediaLibrarySummary } from '@/services/media-library';
import type { StorageBreakdown } from '@/services/storage';
import type { Page } from '@/types/models';

/**
 * The admin console's data layer.
 *
 * Everything here polls rather than subscribing: an operations screen is looked
 * at occasionally and closed, and a socket channel carrying counters would run
 * for every open tab all day to serve a number nobody is reading.
 */

/** Counters and the fourteen-day activity series, in one request. */
export function useAdminOverview(): UseQueryResult<AdminOverview, Error> {
  return useQuery({
    queryKey: queryKeys.admin.overview(),
    queryFn: () => api.get<AdminOverview>('/api/admin/overview'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/** Liveness. Polled fastest, because a red light nobody sees is not a light. */
export function useSystemHealth(): UseQueryResult<SystemHealth, Error> {
  return useQuery({
    queryKey: queryKeys.admin.health(),
    queryFn: () => api.get<SystemHealth>('/api/admin/health'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useAdminUsers(): UseQueryResult<AdminUserRow[], Error> {
  return useQuery({
    queryKey: queryKeys.admin.users(),
    queryFn: () => api.get<AdminUserRow[]>('/api/admin/users'),
    refetchInterval: 60_000,
  });
}

export function useAdminSessions(): UseQueryResult<AdminSessionRow[], Error> {
  return useQuery({
    queryKey: queryKeys.admin.sessions(),
    queryFn: () => api.get<AdminSessionRow[]>('/api/admin/sessions'),
    refetchInterval: 30_000,
  });
}

/** Force-ends a session. The socket for it is disconnected server-side too. */
export function useRevokeSession(): UseMutationResult<{ revoked: true }, Error, string> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (sessionId) =>
      api.delete<{ revoked: true }>('/api/admin/sessions', { body: { sessionId } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.admin.sessions() });
      void client.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useAdminStorage(): UseQueryResult<StorageBreakdown, Error> {
  return useQuery({
    queryKey: queryKeys.admin.storage(),
    queryFn: () => api.get<StorageBreakdown>('/api/admin/storage'),
    refetchInterval: 60_000,
  });
}

/** Deletes uploads that were never attached to a message. */
export function usePruneStorage(): UseMutationResult<{ pruned: number }, Error, void> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ pruned: number }>('/api/admin/storage'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.admin.storage() });
      void client.invalidateQueries({ queryKey: queryKeys.admin.overview() });
    },
  });
}

// --- instance settings -----------------------------------------------------

export function useAppSettings(): UseQueryResult<AppSettingsDTO, Error> {
  return useQuery({
    queryKey: queryKeys.admin.settings(),
    queryFn: () => api.get<AppSettingsDTO>('/api/admin/settings'),
    staleTime: 5_000,
  });
}

export type AppSettingsAction =
  | {
      action: 'disappearing-mode';
      enabled: boolean;
      rule?: string;
      maxViews?: number | null;
      expiresInSeconds?: number | null;
    }
  | { action: 'restore-hidden' };

/**
 * Writes an instance setting.
 *
 * The overview and storage panes are invalidated alongside the settings
 * themselves because hiding the history changes the counters they display.
 */
export function useUpdateAppSettings(): UseMutationResult<
  AppSettingsDTO,
  Error,
  AppSettingsAction
> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body) => api.patch<AppSettingsDTO>('/api/admin/settings', { body }),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.admin.settings(), settings);
      void client.invalidateQueries({ queryKey: queryKeys.admin.overview() });
    },
  });
}

// --- devices, calls, uploads, database, analytics --------------------------

export function useAdminDevices(): UseQueryResult<AdminDeviceRow[], Error> {
  return useQuery({
    queryKey: queryKeys.admin.devices(),
    queryFn: () => api.get<AdminDeviceRow[]>('/api/admin/devices'),
    refetchInterval: 60_000,
  });
}

export function useCallStats(): UseQueryResult<CallStats, Error> {
  return useQuery({
    queryKey: queryKeys.admin.callStats(),
    queryFn: () => api.get<CallStats>('/api/admin/calls/stats'),
    refetchInterval: 60_000,
  });
}

const CALLS_PAGE_SIZE = 40;

export function useCallLog(status?: string): UseInfiniteQueryResult<CallsData, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.admin.calls({ status }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Page<AdminCallRow>>('/api/admin/calls', {
        searchParams: {
          limit: CALLS_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(status ? { status } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });
}

export function useUploadStats(): UseQueryResult<UploadStats, Error> {
  return useQuery({
    queryKey: queryKeys.admin.uploads(),
    queryFn: () => api.get<UploadStats>('/api/admin/uploads'),
    refetchInterval: 60_000,
  });
}

/** Row counts and engine details. Heavier than the health probe, so slower. */
export function useDatabaseStatus(): UseQueryResult<DatabaseStatus, Error> {
  return useQuery({
    queryKey: queryKeys.admin.database(),
    queryFn: () => api.get<DatabaseStatus>('/api/admin/database'),
    refetchInterval: 60_000,
  });
}

export function useSystemAnalytics(): UseQueryResult<SystemAnalytics, Error> {
  return useQuery({
    queryKey: queryKeys.admin.analytics(),
    queryFn: () => api.get<SystemAnalytics>('/api/admin/analytics'),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

// --- error log -------------------------------------------------------------

export function useErrorSummary(): UseQueryResult<ErrorSummary, Error> {
  return useQuery({
    queryKey: queryKeys.admin.errorSummary(),
    queryFn: () => api.get<ErrorSummary>('/api/admin/errors/summary'),
    refetchInterval: 30_000,
  });
}

const ERRORS_PAGE_SIZE = 50;

export function useErrorLog(severity?: string): UseInfiniteQueryResult<ErrorsData, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.admin.errors({ severity }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Page<ErrorLogRow>>('/api/admin/errors', {
        searchParams: {
          limit: ERRORS_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(severity ? { severity } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });
}

// --- media library ---------------------------------------------------------

export function useMediaSummary(): UseQueryResult<MediaLibrarySummary, Error> {
  return useQuery({
    queryKey: queryKeys.admin.mediaSummary(),
    queryFn: () => api.get<MediaLibrarySummary>('/api/admin/media/summary'),
    refetchInterval: 60_000,
  });
}

const MEDIA_PAGE_SIZE = 40;

/**
 * The library listing.
 *
 * Metadata only, by design — there is no URL in the response to render, so this
 * hook cannot become an accidental viewer for the other account's attachments.
 */
export function useMediaLibrary(filters: {
  group?: string;
  state?: string;
}): UseInfiniteQueryResult<MediaData, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.admin.media(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Page<MediaLibraryRow>>('/api/admin/media', {
        searchParams: {
          limit: MEDIA_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(filters.group ? { group: filters.group } : {}),
          ...(filters.state ? { state: filters.state } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });
}

type AuditData = InfiniteData<Page<AuditLogRow>, string | null>;
type CallsData = InfiniteData<Page<AdminCallRow>, string | null>;
type ErrorsData = InfiniteData<Page<ErrorLogRow>, string | null>;
type MediaData = InfiniteData<Page<MediaLibraryRow>, string | null>;

const AUDIT_PAGE_SIZE = 50;

/**
 * The audit trail.
 *
 * Cursor-paginated like every other list in the app; `action` is part of the
 * query key so switching the filter starts a fresh page chain rather than
 * appending filtered rows underneath unfiltered ones.
 */
export function useAuditLog(action?: string): UseInfiniteQueryResult<AuditData, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.admin.audit({ action }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Page<AuditLogRow>>('/api/admin/audit', {
        searchParams: {
          limit: AUDIT_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(action ? { action } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });
}
