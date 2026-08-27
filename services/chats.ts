import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import type { ChatSummaryDTO, PublicProfile } from '@/types/models';

import { ensureDuoChat } from './provisioning';

/**
 * Everything the chat screen needs before it can render, in one query.
 *
 * There is exactly one conversation, so this takes a user rather than a chat
 * id: asking "which chat?" would imply a choice that does not exist, and the
 * caller would only have to look the single row up first anyway.
 */
export async function getChatForUser(userId: string): Promise<ChatSummaryDTO | null> {
  const membership = await db.chatMember.findFirst({
    where: { userId },
    orderBy: { joinedAt: 'asc' },
    select: {
      unreadCount: true,
      lastReadMessageId: true,
      muted: true,
      chat: {
        select: {
          id: true,
          slug: true,
          title: true,
          wallpaperUrl: true,
          lastMessageAt: true,
          members: {
            select: {
              user: {
                select: {
                  id: true,
                  profile: {
                    select: {
                      username: true,
                      displayName: true,
                      bio: true,
                      avatarUrl: true,
                      statusText: true,
                      presence: true,
                      lastSeenAt: true,
                      showLastSeen: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // The second account has not registered yet, or the row was lost — either way
  // this repairs it rather than rendering an app with nowhere to talk.
  if (!membership) {
    const chatId = await ensureDuoChat();
    if (!chatId) return null;
    return getChatForUser(userId);
  }

  const chat = membership.chat;

  const participants: PublicProfile[] = chat.members.flatMap((member) => {
    const profile = member.user.profile;
    if (!profile) return [];

    return [
      {
        userId: member.user.id,
        username: profile.username,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        statusText: profile.statusText,
        presence: profile.presence,
        // Honouring the privacy toggle here rather than in the component is
        // deliberate: a value the client never receives cannot be leaked by a
        // future component that forgets to check the flag.
        lastSeenAt: profile.showLastSeen ? profile.lastSeenAt.toISOString() : null,
      },
    ];
  });

  return {
    id: chat.id,
    slug: chat.slug,
    title: chat.title,
    wallpaperUrl: chat.wallpaperUrl,
    unreadCount: membership.unreadCount,
    lastReadMessageId: membership.lastReadMessageId,
    muted: membership.muted,
    lastMessageAt: chat.lastMessageAt.toISOString(),
    participants,
  };
}

/** The same, but throwing — for route handlers that cannot render an empty state. */
export async function requireChatForUser(userId: string): Promise<ChatSummaryDTO> {
  const chat = await getChatForUser(userId);
  if (!chat) throw notFound('No conversation exists yet');
  return chat;
}
