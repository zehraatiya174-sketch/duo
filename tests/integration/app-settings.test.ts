// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaMock, resetPrismaMock } from '../helpers/prisma-mock';
import { ALICE } from '../helpers/factories';

const prisma = createPrismaMock();
vi.mock('@/lib/db', () => ({ db: prisma }));

const {
  appSettings,
  appSettingsDto,
  applyDisappearingDefault,
  invalidateAppSettings,
  messageVisibilityWhere,
  restoreHiddenMessages,
  setDisappearingMode,
} = await import('@/services/app-settings');

const ROW = {
  id: 'global',
  disappearingMode: false,
  disappearingRule: 'VIEW_ONCE' as const,
  disappearingMaxViews: null,
  disappearingExpiresInSeconds: null,
  messagesHiddenBefore: null as Date | null,
  updatedAt: new Date('2026-07-30T10:00:00.000Z'),
  updatedById: ALICE,
};

beforeEach(() => {
  resetPrismaMock(prisma);
  // The row is read on nearly every send, so it is cached in process; each test
  // starts from a clean read.
  invalidateAppSettings();
  prisma.appSetting.findUnique.mockResolvedValue(ROW);
  prisma.appSetting.upsert.mockResolvedValue(ROW);
  prisma.auditLog.create.mockResolvedValue({});
  prisma.message.count.mockResolvedValue(0);
});

describe('appSettings', () => {
  it('falls back to a permissive default when the row is missing', async () => {
    prisma.appSetting.findUnique.mockResolvedValue(null);

    await expect(appSettings()).resolves.toMatchObject({
      disappearingMode: false,
      messagesHiddenBefore: null,
    });
  });

  it('treats a read failure as "everything visible" rather than hiding the chat', async () => {
    prisma.appSetting.findUnique.mockRejectedValue(new Error('connection lost'));

    await expect(messageVisibilityWhere()).resolves.toEqual({});
  });

  it('serves repeat reads from cache instead of querying per message', async () => {
    await appSettings();
    await appSettings();

    expect(prisma.appSetting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('messageVisibilityWhere', () => {
  it('is empty while nothing is hidden', async () => {
    await expect(messageVisibilityWhere()).resolves.toEqual({});
  });

  it('bounds queries to messages sent after the hidden mark', async () => {
    const hiddenBefore = new Date('2026-07-31T09:00:00.000Z');
    prisma.appSetting.findUnique.mockResolvedValue({ ...ROW, messagesHiddenBefore: hiddenBefore });

    await expect(messageVisibilityWhere()).resolves.toEqual({ createdAt: { gte: hiddenBefore } });
  });
});

describe('applyDisappearingDefault', () => {
  it('leaves messages ordinary while the switch is off', async () => {
    await expect(applyDisappearingDefault(undefined)).resolves.toEqual({ mode: 'NORMAL' });
  });

  it('seals an unmarked message once the switch is on', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({ ...ROW, disappearingMode: true });

    await expect(applyDisappearingDefault(undefined)).resolves.toMatchObject({
      mode: 'VIEW_ONCE',
    });
  });

  it('never overrides what the sender chose for themselves', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({
      ...ROW,
      disappearingMode: true,
      disappearingRule: 'VIEW_TWICE',
    });

    await expect(
      applyDisappearingDefault({ mode: 'VIEW_ONCE', destructAfterSeconds: 10 }),
    ).resolves.toEqual({ mode: 'VIEW_ONCE', destructAfterSeconds: 10 });
  });

  it('carries the configured expiry onto forced timed messages', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({
      ...ROW,
      disappearingMode: true,
      disappearingRule: 'UNLIMITED_TIMED',
      disappearingExpiresInSeconds: 86_400,
    });

    await expect(applyDisappearingDefault(undefined)).resolves.toMatchObject({
      mode: 'UNLIMITED_TIMED',
      expiresInSeconds: 86_400,
    });
  });
});

describe('setDisappearingMode', () => {
  it('hides the existing history when the switch goes off', async () => {
    await setDisappearingMode(ALICE, { enabled: false });

    const write = prisma.appSetting.upsert.mock.calls[0]?.[0] as {
      update: { messagesHiddenBefore: Date | null };
    };
    expect(write.update.messagesHiddenBefore).toBeInstanceOf(Date);
  });

  it('destroys nothing — no message is deleted or emptied', async () => {
    await setDisappearingMode(ALICE, { enabled: false });

    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
  });

  it('records both the switch and the hiding in the audit trail', async () => {
    await setDisappearingMode(ALICE, { enabled: false });

    const actions = prisma.auditLog.create.mock.calls.map(
      (call) => (call[0] as { data: { action: string } }).data.action,
    );
    expect(actions).toEqual(['DISAPPEARING_MODE_CHANGED', 'MESSAGES_HIDDEN']);
  });

  it('does not un-hide a withdrawn history just because the switch went back on', async () => {
    const hiddenBefore = new Date('2026-07-31T09:00:00.000Z');
    prisma.appSetting.findUnique.mockResolvedValue({ ...ROW, messagesHiddenBefore: hiddenBefore });

    await setDisappearingMode(ALICE, { enabled: true });

    const write = prisma.appSetting.upsert.mock.calls[0]?.[0] as {
      update: { messagesHiddenBefore: Date | null };
    };
    expect(write.update.messagesHiddenBefore).toEqual(hiddenBefore);
  });

  it('rejects a custom-views rule with no view count', async () => {
    await expect(
      setDisappearingMode(ALICE, { enabled: true, rule: 'CUSTOM_VIEWS' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('restoreHiddenMessages', () => {
  it('lifts the mark and says so in the audit trail', async () => {
    const hiddenBefore = new Date('2026-07-31T09:00:00.000Z');
    prisma.appSetting.findUnique.mockResolvedValue({ ...ROW, messagesHiddenBefore: hiddenBefore });

    await restoreHiddenMessages(ALICE);

    const write = prisma.appSetting.upsert.mock.calls[0]?.[0] as {
      update: { messagesHiddenBefore: Date | null };
    };
    expect(write.update.messagesHiddenBefore).toBeNull();

    const entry = prisma.auditLog.create.mock.calls[0]?.[0] as { data: { action: string } };
    expect(entry.data.action).toBe('MESSAGES_RESTORED');
  });
});

describe('appSettingsDto', () => {
  it('counts what is being withheld so the operator can see the cost', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({
      ...ROW,
      messagesHiddenBefore: new Date('2026-07-31T09:00:00.000Z'),
    });
    prisma.message.count.mockResolvedValue(412);

    await expect(appSettingsDto()).resolves.toMatchObject({
      hiddenMessageCount: 412,
      messagesHiddenBefore: '2026-07-31T09:00:00.000Z',
    });
  });

  it('does not count anything while nothing is hidden', async () => {
    await expect(appSettingsDto()).resolves.toMatchObject({ hiddenMessageCount: 0 });
    expect(prisma.message.count).not.toHaveBeenCalled();
  });
});
