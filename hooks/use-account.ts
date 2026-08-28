'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { usePreferences } from '@/components/providers/preferences-provider';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import type { UpdateProfileInput } from '@/lib/validation/profile';
import type { UpdateSettingsInput } from '@/lib/validation/settings';
import type { OwnProfileDTO } from '@/services/profile';
import type { SettingsDTO } from '@/services/settings';

/**
 * The signed-in person's own settings and profile.
 *
 * Settings arrive twice: once from the server through `PreferencesProvider`,
 * which is what makes the first paint correct, and again through this query
 * once the panel is opened. The provider stays the source of truth for
 * *rendering* — the mutation below pushes each change into it immediately, so
 * a theme switch lands on the next frame rather than after a round trip.
 */
export function useSettings(): UseQueryResult<SettingsDTO, Error> {
  const { settings } = usePreferences();

  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => api.get<SettingsDTO>('/api/settings'),
    // The provider already has a server-rendered copy, so the panel opens
    // populated instead of blank.
    initialData: settings,
    staleTime: 30_000,
  });
}

export function useUpdateSettings(): UseMutationResult<
  SettingsDTO,
  Error,
  UpdateSettingsInput
> {
  const client = useQueryClient();
  const { apply } = usePreferences();

  return useMutation({
    mutationFn: (input) => api.patch<SettingsDTO>('/api/settings', { body: input }),
    // Applied before the request so a toggle feels instant. A failure re-syncs
    // from the server below rather than being papered over.
    onMutate: (input) => {
      apply(input);
    },
    onSuccess: (updated) => {
      client.setQueryData(queryKeys.settings(), updated);
      apply(updated);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
}

export function useProfile(): UseQueryResult<OwnProfileDTO, Error> {
  return useQuery({
    queryKey: queryKeys.profile(),
    queryFn: () => api.get<OwnProfileDTO>('/api/profile'),
    staleTime: 30_000,
  });
}

export function useUpdateProfile(): UseMutationResult<OwnProfileDTO, Error, UpdateProfileInput> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input) => api.patch<OwnProfileDTO>('/api/profile', { body: input }),
    onSuccess: (updated) => {
      client.setQueryData(queryKeys.profile(), updated);
      // The header and every message bubble render the display name, and both
      // read it from the participant list rather than from here.
      void client.invalidateQueries({ queryKey: queryKeys.participants() });
    },
  });
}
