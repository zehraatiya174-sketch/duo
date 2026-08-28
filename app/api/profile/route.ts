import { NextResponse } from 'next/server';

import { authedRoute, readJson } from '@/lib/api/respond';
import { updateProfileSchema } from '@/lib/validation/profile';
import { getOwnProfile, updateOwnProfile, type OwnProfileDTO } from '@/services/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in person's own profile, including the privacy toggles that are
 * never sent to the peer.
 */
export const GET = authedRoute<Record<string, never>, OwnProfileDTO>(async ({ user }) => {
  return NextResponse.json<OwnProfileDTO>(await getOwnProfile(user.id));
});

export const PATCH = authedRoute<Record<string, never>, OwnProfileDTO>(
  async ({ request, user }) => {
    const input = updateProfileSchema.parse(await readJson(request));
    return NextResponse.json<OwnProfileDTO>(await updateOwnProfile(user.id, input));
  },
);
