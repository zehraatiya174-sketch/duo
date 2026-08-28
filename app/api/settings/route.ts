import { NextResponse } from 'next/server';

import { authedRoute, readJson } from '@/lib/api/respond';
import { updateSettingsSchema } from '@/lib/validation/settings';
import { getSettings, updateSettings, type SettingsDTO } from '@/services/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in person's own display preferences.
 *
 * Scoped to `user.id` from the session rather than anything in the request, so
 * there is no addressable way to read or write the other account's settings.
 */
export const GET = authedRoute<Record<string, never>, SettingsDTO>(async ({ user }) => {
  return NextResponse.json<SettingsDTO>(await getSettings(user.id));
});

/** Partial update — the settings panel sends only what actually changed. */
export const PATCH = authedRoute<Record<string, never>, SettingsDTO>(async ({ request, user }) => {
  const input = updateSettingsSchema.parse(await readJson(request));
  return NextResponse.json<SettingsDTO>(await updateSettings(user.id, input));
});
