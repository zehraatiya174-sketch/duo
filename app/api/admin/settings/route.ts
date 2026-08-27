import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, readJson } from '@/lib/api/respond';
import { ephemeralModeSchema } from '@/lib/validation/message';
import {
  type AppSettingsDTO,
  appSettingsDto,
  restoreHiddenMessages,
  setDisappearingMode,
} from '@/services/app-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('disappearing-mode'),
    enabled: z.boolean(),
    rule: ephemeralModeSchema.optional(),
    maxViews: z.number().int().min(1).max(99).nullable().optional(),
    expiresInSeconds: z.number().int().min(5).max(2_592_000).nullable().optional(),
  }),
  // The only route back from a switch-off. Kept as a separate action rather
  // than a side effect of re-enabling, so restoring the history is always a
  // deliberate administrative decision.
  z.object({ action: z.literal('restore-hidden') }),
]);

export const GET = adminRoute<Record<string, never>, AppSettingsDTO>(async () => {
  return NextResponse.json(await appSettingsDto(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});

export const PATCH = adminRoute<Record<string, never>, AppSettingsDTO>(async ({ request, user }) => {
  const body = bodySchema.parse(await readJson(request));

  const settings =
    body.action === 'restore-hidden'
      ? await restoreHiddenMessages(user.id)
      : await setDisappearingMode(user.id, {
          enabled: body.enabled,
          rule: body.rule,
          maxViews: body.maxViews,
          expiresInSeconds: body.expiresInSeconds,
        });

  return NextResponse.json(settings);
});
