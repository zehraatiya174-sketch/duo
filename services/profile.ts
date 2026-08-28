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
 * Renames another account, for the admin console.
 *
 * This edits the other person's **real** display name — the one they see on
 * their own profile screen and the one that appears on their messages for both
 * of you. It is not a private nickname visible only to the editor; there is no
 * per-viewer alias in the schema, and inventing one silently would be worse
 * than being explicit about which of the two this is.
 *
 * Audited under the editor's id with the target named, because someone's name
 * changing without their action is exactly the kind of event that should be
 * explicable afterwards.
 */
export async function renameAccount(
  actorId: string,
  targetUserId: string,
  displayName: string,
): Promise<OwnProfileDTO> {
  const profile = await db.profile.update({
    where: { userId: targetUserId },
    data: { displayName },
    select: selection,
  });

  await db.auditLog.create({
    data: {
      userId: actorId,
      action: 'PROFILE_UPDATED',
      metadata: { targetUserId, fields: ['displayName'], byAdmin: true },
    },
  });

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
