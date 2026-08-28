import { z } from 'zod';

/**
 * What a person may change about how they appear to the other account.
 *
 * `.strict()` matters: the parsed object is spread into a Prisma `update`, so
 * an unlisted key would otherwise be a way to write an arbitrary column on
 * `Profile` — `username`, or somebody else's `presence`.
 *
 * `avatarUrl` is deliberately absent. `next.config.ts` pins `img-src` to a
 * short allowlist, so an arbitrary avatar URL would be accepted here and then
 * silently refuse to render — a setting that looks like it worked and did not.
 * The initials fallback is tinted from the display name, so it already tracks
 * this form.
 */
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter a display name').max(60),
    // Lengths mirror the column widths in schema.prisma; anything longer would
    // be truncated by Postgres rather than rejected here.
    statusText: z.string().trim().max(80).nullable(),
    bio: z.string().trim().max(280).nullable(),
    /** Hides the last-seen timestamp from the other account. */
    showLastSeen: z.boolean(),
    /** Stops sending read receipts. Applies in both directions. */
    showReadReceipts: z.boolean(),
  })
  .partial()
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
