import type { UserSettings } from '@prisma/client';

import { db } from '@/lib/db';
import type { UpdateSettingsInput } from '@/lib/validation/settings';

export interface SettingsDTO {
  theme: UserSettings['theme'];
  accentColor: string;
  wallpaperUrl: string | null;
  fontSize: UserSettings['fontSize'];
  language: string;
  reducedMotion: boolean;
  highContrast: boolean;
  notificationsEnabled: boolean;
  notificationSound: boolean;
  desktopNotifications: boolean;
  soundPack: string;
  enterToSend: boolean;
  mediaAutoDownload: UserSettings['mediaAutoDownload'];
  blurNsfwPreviews: boolean;
  screenshotWarnings: boolean;
}

function serialize(settings: UserSettings): SettingsDTO {
  return {
    theme: settings.theme,
    accentColor: settings.accentColor,
    wallpaperUrl: settings.wallpaperUrl,
    fontSize: settings.fontSize,
    language: settings.language,
    reducedMotion: settings.reducedMotion,
    highContrast: settings.highContrast,
    notificationsEnabled: settings.notificationsEnabled,
    notificationSound: settings.notificationSound,
    desktopNotifications: settings.desktopNotifications,
    soundPack: settings.soundPack,
    enterToSend: settings.enterToSend,
    mediaAutoDownload: settings.mediaAutoDownload,
    blurNsfwPreviews: settings.blurNsfwPreviews,
    screenshotWarnings: settings.screenshotWarnings,
  };
}

/**
 * Settings are created at provisioning time, but this upserts anyway so a row
 * that went missing never turns into a 500 on a settings page load.
 */
export async function getSettings(userId: string): Promise<SettingsDTO> {
  const settings = await db.userSettings.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  return serialize(settings);
}

export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
): Promise<SettingsDTO> {
  const settings = await db.userSettings.upsert({
    where: { userId },
    update: input,
    create: { userId, ...input },
  });

  await db.auditLog.create({
    data: { userId, action: 'SETTINGS_UPDATED', metadata: { fields: Object.keys(input) } },
  });

  return serialize(settings);
}
