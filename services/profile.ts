import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import type { UpdateProfileInput } from '@/lib/validation/profile';

export interface OwnProfileDTO {
  userId: string;
  username: string;
  displayName: string;
  statusText: string | null;
  bio: string | null;
  avatarUrl: string | null;
  showLastSeen: boolean;
  showReadReceipts: boolean;
}

const selection = {
  userId: true,
  username: true,
  displayName: true,
  statusText: true,
  bio: true,
  avatarUrl: true,
  showLastSeen: true,
  showReadReceipts: true,
} as const;

/**
 * The signed-in person's own profile.
 *
 * Distinct from `PublicProfile`, which is what the *other* account sees: this
 * one carries the privacy toggles themselves, which are settings rather than
 * facts about the person and must never travel to the peer.
 */
export async function getOwnProfile(userId: string): Promise<OwnProfileDTO> {
  const profile = await db.profile.findUnique({ where: { userId }, select: selection });
  if (!profile) throw notFound('No profile exists for this account');
  return profile;
}

/**
 * Applies a partial profile change.
 *
 * Audited, because `showReadReceipts` and `showLastSeen` change what the other
 * person can observe. A conversation between two people where one quietly stops
 * sending receipts should leave a trace the pair can look at, rather than being
 * indistinguishable from a bug.
 */
export async function updateOwnProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<OwnProfileDTO> {
  // Nothing to do, and an empty Prisma `update` would still write updatedAt.
  if (Object.keys(input).length === 0) return getOwnProfile(userId);

  const profile = await db.profile.update({
    where: { userId },
    data: input,
    select: selection,
  });

  await db.auditLog.create({
    data: {
      userId,
      action: 'PROFILE_UPDATED',
      // Field names only. The values are the user's own words and do not belong
      // in a log that the other account can read through the admin console.
      metadata: { fields: Object.keys(input) },
    },
  });

  return profile;
}
