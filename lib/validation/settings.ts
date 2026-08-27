import { z } from 'zod';

/**
 * Display preferences the user may change.
 *
 * Every field is optional — the settings panel PATCHes only what moved — and
 * `.strict()` is what keeps this safe: the parsed object is spread straight
 * into a Prisma `update`, so an unlisted key would otherwise be a way to write
 * an arbitrary column on `UserSettings`.
 */

/** Matches the Prisma enums; kept as literals so the client need not import them. */
const themeSchema = z.enum(['LIGHT', 'DARK', 'SYSTEM']);
const fontSizeSchema = z.enum(['SMALL', 'MEDIUM', 'LARGE', 'XLARGE']);
const mediaAutoDownloadSchema = z.enum(['ALWAYS', 'WIFI_ONLY', 'NEVER']);

/**
 * A CSS colour written into a custom property on `<html>`.
 *
 * Restricted to a hex literal rather than accepting any colour string: the
 * value is interpolated into `style.setProperty`, and something like
 * `red; background-image: url(...)` would otherwise be injectable.
 */
const accentColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #4f46e5');

export const updateSettingsSchema = z
  .object({
    theme: themeSchema,
    accentColor: accentColorSchema,
    wallpaperUrl: z.string().url().max(2048).nullable(),
    fontSize: fontSizeSchema,
    // BCP-47-ish; the app ships one locale but the column is already there.
    language: z.string().trim().min(2).max(12),
    reducedMotion: z.boolean(),
    highContrast: z.boolean(),
    notificationsEnabled: z.boolean(),
    notificationSound: z.boolean(),
    desktopNotifications: z.boolean(),
    soundPack: z.string().trim().min(1).max(40),
    enterToSend: z.boolean(),
    mediaAutoDownload: mediaAutoDownloadSchema,
    blurNsfwPreviews: z.boolean(),
    screenshotWarnings: z.boolean(),
  })
  .partial()
  .strict();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
