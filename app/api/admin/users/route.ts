import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, readJson } from '@/lib/api/respond';
import { type AdminUserRow, listUsers } from '@/services/admin';
import { renameAccount, type OwnProfileDTO } from '@/services/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute<Record<string, never>, AdminUserRow[]>(async () => {
  return NextResponse.json(await listUsers(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});

const renameSchema = z
  .object({
    userId: z.string().min(1),
    displayName: z.string().trim().min(1, 'Enter a display name').max(60),
  })
  .strict();

/**
 * Renames an account.
 *
 * Deliberately narrow: `displayName` and nothing else. `.strict()` keeps the
 * body from carrying `role`, `banned` or a `username`, none of which should be
 * reachable through a rename.
 */
export const PATCH = adminRoute<Record<string, never>, OwnProfileDTO>(async ({ request, user }) => {
  const { userId, displayName } = renameSchema.parse(await readJson(request));
  return NextResponse.json<OwnProfileDTO>(await renameAccount(user.id, userId, displayName));
});
