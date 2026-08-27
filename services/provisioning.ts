import { db } from '@/lib/db';
import { authorizedEmails } from '@/lib/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('provisioning');

/**
 * There is exactly one conversation in this deployment, and it is found by this
 * slug rather than by id — the id is generated, so nothing could look it up on
 * a fresh database without a well-known handle.
 */
export const DUO_CHAT_SLUG = 'duo';

export interface ProvisionInput {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

/**
 * Gives a newly created account everything the app assumes exists.
 *
 * Called from the `user.create.after` hook, so it runs exactly once per account
 * and before the first request that account makes. Every write is an upsert:
 * the hook can be retried by Better Auth, and a half-provisioned user is a much
 * worse outcome than a redundant write.
 *
 * The username is derived from the local part of the address and de-duplicated,
 * because `Profile.username` is unique and two allowlisted addresses can easily
 * share one — `me@gmail.com` and `me@work.com` both want `me`.
 */
export async function provisionUser(input: ProvisionInput): Promise<void> {
  const base = (input.email.split('@')[0] ?? 'user').replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const desired = base.length >= 2 ? base : 'user';

  await db.profile.upsert({
    where: { userId: input.id },
    update: {},
    create: {
      userId: input.id,
      username: await uniqueUsername(desired),
      displayName: input.name || desired,
      avatarUrl: input.image ?? null,
    },
  });

  await db.userSettings.upsert({
    where: { userId: input.id },
    update: {},
    create: { userId: input.id },
  });

  log.info('Provisioned account', { userId: input.id });

  // Harmless before the second person registers — it simply does nothing until
  // both accounts exist.
  await ensureDuoChat();
}

/** Appends a numeric suffix until the handle is free. */
async function uniqueUsername(desired: string): Promise<string> {
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? desired : `${desired}${suffix}`;
    const taken = await db.profile.findUnique({
      where: { username: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  // Practically unreachable with two accounts; still better than throwing
  // inside an account-creation hook.
  return `${desired}-${Date.now().toString(36)}`;
}

/**
 * Creates the shared conversation once both allowlisted accounts exist, and
 * makes sure both are members of it.
 *
 * Idempotent, and called from two places: after each account is provisioned,
 * and at server boot. The boot call is what repairs a deployment whose database
 * was restored or migrated without the chat row — otherwise the app would come
 * up with two valid users and nowhere to talk.
 */
export async function ensureDuoChat(): Promise<string | null> {
  const users = await db.user.findMany({
    where: { email: { in: [...authorizedEmails()] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  // One person registered so far. Nothing to do yet.
  if (users.length < 2) return null;

  const chat = await db.chat.upsert({
    where: { slug: DUO_CHAT_SLUG },
    update: {},
    create: { slug: DUO_CHAT_SLUG },
    select: { id: true },
  });

  for (const user of users) {
    await db.chatMember.upsert({
      where: { chatId_userId: { chatId: chat.id, userId: user.id } },
      update: {},
      create: { chatId: chat.id, userId: user.id },
    });
  }

  return chat.id;
}
