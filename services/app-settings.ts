import type { EphemeralMode, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EphemeralOptions } from '@/lib/validation/message';

const log = createLogger('app-settings');

/** The settings row is a singleton; its id is fixed. */
const SETTINGS_ID = 'global';

/**
 * How long a read of the settings row is trusted.
 *
 * Every send and every page of history consults these settings, so hitting the
 * database each time would put a query on the hottest path in the app. Writes
 * invalidate the cache directly, and the app and socket servers share a
 * process, so the TTL only matters if a row is changed out of band.
 */
const CACHE_TTL_MS = 5_000;

export interface AppSettingsRecord {
  disappearingMode: boolean;
  disappearingRule: EphemeralMode;
  disappearingMaxViews: number | null;
  disappearingExpiresInSeconds: number | null;
  messagesHiddenBefore: Date | null;
  updatedAt: Date | null;
  updatedById: string | null;
}

/** What the admin panel renders. Dates are ISO strings on the wire. */
export interface AppSettingsDTO {
  disappearingMode: boolean;
  disappearingRule: EphemeralMode;
  disappearingMaxViews: number | null;
  disappearingExpiresInSeconds: number | null;
  messagesHiddenBefore: string | null;
  /** Messages currently withheld from both users by the hidden-before mark. */
  hiddenMessageCount: number;
  updatedAt: string | null;
  updatedById: string | null;
}

/**
 * The state of a brand-new installation, and the fallback whenever the row
 * cannot be read. Failing open to "everything visible, nothing forced" keeps a
 * settings outage from looking like data loss.
 */
const DEFAULTS: AppSettingsRecord = {
  disappearingMode: false,
  disappearingRule: 'VIEW_ONCE',
  disappearingMaxViews: null,
  disappearingExpiresInSeconds: null,
  messagesHiddenBefore: null,
  updatedAt: null,
  updatedById: null,
};

let cache: { value: AppSettingsRecord; readAt: number } | null = null;

export function invalidateAppSettings(): void {
  cache = null;
}

export async function appSettings(): Promise<AppSettingsRecord> {
  if (cache && Date.now() - cache.readAt < CACHE_TTL_MS) return cache.value;

  try {
    const row = await db.appSetting.findUnique({ where: { id: SETTINGS_ID } });
    const value: AppSettingsRecord = row
      ? {
          disappearingMode: row.disappearingMode,
          disappearingRule: row.disappearingRule,
          disappearingMaxViews: row.disappearingMaxViews,
          disappearingExpiresInSeconds: row.disappearingExpiresInSeconds,
          messagesHiddenBefore: row.messagesHiddenBefore,
          updatedAt: row.updatedAt,
          updatedById: row.updatedById,
        }
      : DEFAULTS;

    cache = { value, readAt: Date.now() };
    return value;
  } catch (error) {
    log.error('Failed to read app settings; falling back to defaults', { error });
    return DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// Reads used on the hot path
// ---------------------------------------------------------------------------

/**
 * The visibility clause every message query is filtered by.
 *
 * Turning Disappearing Mode off hides the existing conversation, and this is
 * how: a single timestamp on the settings row, compared against `createdAt`.
 * No message row is touched, no body is cleared and no blob is deleted, so the
 * conversation comes back intact if an admin restores it — but until then the
 * app behaves for both users as though the history were gone.
 */
export async function messageVisibilityWhere(): Promise<Prisma.MessageWhereInput> {
  const settings = await appSettings();
  return settings.messagesHiddenBefore
    ? { createdAt: { gte: settings.messagesHiddenBefore } }
    : {};
}

/**
 * The ephemeral options a new message should carry.
 *
 * A message the sender already marked as disappearing keeps exactly what they
 * chose — the global switch raises the floor, it does not override a deliberate
 * per-message decision.
 */
export async function applyDisappearingDefault(
  requested: EphemeralOptions | undefined,
): Promise<EphemeralOptions> {
  const chosen: EphemeralOptions = requested ?? { mode: 'NORMAL' };
  if (chosen.mode !== 'NORMAL') return chosen;

  const settings = await appSettings();
  if (!settings.disappearingMode) return chosen;
  if (settings.disappearingRule === 'NORMAL') return chosen;

  return {
    mode: settings.disappearingRule,
    maxViews: settings.disappearingMaxViews,
    expiresInSeconds: settings.disappearingExpiresInSeconds,
    destructAfterSeconds: chosen.destructAfterSeconds ?? null,
  };
}

// ---------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------

async function persist(
  data: Prisma.AppSettingUpdateInput,
  createData: Omit<Prisma.AppSettingCreateInput, 'id'>,
): Promise<void> {
  await db.appSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...createData },
    update: data,
  });
  invalidateAppSettings();
  await broadcast();
}

/**
 * Tells every connected client the rules changed.
 *
 * "Takes effect immediately" is the requirement, and a client that only learns
 * about a hidden history on its next reload would not meet it. The socket
 * server may be absent during tests or a serverless render, which is why this
 * never throws.
 */
async function broadcast(): Promise<void> {
  try {
    const { getSocketServer } = await import('@/socket/context');
    const io = getSocketServer();
    if (!io) return;
    const settings = await appSettings();
    io.emit('settings:updated', {
      disappearingMode: settings.disappearingMode,
      historyHidden: settings.messagesHiddenBefore !== null,
    });
  } catch (error) {
    log.debug('Could not broadcast settings change', { error });
  }
}

export interface DisappearingModeInput {
  enabled: boolean;
  rule?: EphemeralMode;
  maxViews?: number | null;
  expiresInSeconds?: number | null;
}

/**
 * Flips the global Disappearing Mode.
 *
 * On:  new messages are sealed automatically, following the configured rule.
 * Off: the existing history is withdrawn from view for both users, and new
 *      messages go back to being ordinary, permanent ones.
 *
 * Switching it back on deliberately does *not* unhide what a previous switch
 * off withdrew — that would make the hidden state a toggle rather than an
 * administrative act. `restoreHiddenMessages` is the one way back.
 */
export async function setDisappearingMode(
  adminId: string,
  input: DisappearingModeInput,
): Promise<AppSettingsDTO> {
  const rule = input.rule ?? 'VIEW_ONCE';

  if (input.enabled && rule === 'CUSTOM_VIEWS' && !input.maxViews) {
    throw badRequest('CUSTOM_VIEWS requires a view count');
  }
  if (input.enabled && rule === 'UNLIMITED_TIMED' && !input.expiresInSeconds) {
    throw badRequest('UNLIMITED_TIMED requires an expiry');
  }

  const previous = await appSettings();
  const hiddenBefore = input.enabled ? previous.messagesHiddenBefore : new Date();

  const shared = {
    disappearingMode: input.enabled,
    disappearingRule: rule,
    disappearingMaxViews: input.maxViews ?? null,
    disappearingExpiresInSeconds: input.expiresInSeconds ?? null,
    messagesHiddenBefore: hiddenBefore,
  };

  await persist({ ...shared, updatedBy: { connect: { id: adminId } } }, {
    ...shared,
    updatedBy: { connect: { id: adminId } },
  });

  await db.auditLog.create({
    data: {
      userId: adminId,
      action: 'DISAPPEARING_MODE_CHANGED',
      metadata: {
        enabled: input.enabled,
        rule,
        maxViews: input.maxViews ?? null,
        expiresInSeconds: input.expiresInSeconds ?? null,
      },
    },
  });

  // Withdrawing the history is the consequential half of this switch, so it
  // gets an audit entry of its own rather than being implied by the one above.
  if (!input.enabled) {
    await db.auditLog.create({
      data: {
        userId: adminId,
        action: 'MESSAGES_HIDDEN',
        metadata: { hiddenBefore: hiddenBefore?.toISOString() ?? null },
      },
    });
  }

  return appSettingsDto();
}

/**
 * Lifts the hidden-before mark, so the withheld history is visible again.
 *
 * Nothing is undeleted here because nothing was deleted: the rows never left
 * the database, which is what makes this recoverable at all.
 */
export async function restoreHiddenMessages(adminId: string): Promise<AppSettingsDTO> {
  const previous = await appSettings();

  await persist(
    { messagesHiddenBefore: null, updatedBy: { connect: { id: adminId } } },
    { messagesHiddenBefore: null, updatedBy: { connect: { id: adminId } } },
  );

  await db.auditLog.create({
    data: {
      userId: adminId,
      action: 'MESSAGES_RESTORED',
      metadata: { previousHiddenBefore: previous.messagesHiddenBefore?.toISOString() ?? null },
    },
  });

  return appSettingsDto();
}

export async function appSettingsDto(): Promise<AppSettingsDTO> {
  const settings = await appSettings();

  const hiddenMessageCount = settings.messagesHiddenBefore
    ? await db.message.count({ where: { createdAt: { lt: settings.messagesHiddenBefore } } })
    : 0;

  return {
    disappearingMode: settings.disappearingMode,
    disappearingRule: settings.disappearingRule,
    disappearingMaxViews: settings.disappearingMaxViews,
    disappearingExpiresInSeconds: settings.disappearingExpiresInSeconds,
    messagesHiddenBefore: settings.messagesHiddenBefore?.toISOString() ?? null,
    hiddenMessageCount,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
    updatedById: settings.updatedById,
  };
}
