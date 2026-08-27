import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import * as React from 'react';

import { SocketProvider } from '@/components/providers/socket-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { ChatScreen } from '@/features/chat/components/chat-screen';
import { getCurrentUser } from '@/lib/auth/session';
import { getChatForUser } from '@/services/chats';

export const metadata: Metadata = { title: 'Chat' };

// The conversation is per-request state; nothing here may be prerendered.
export const dynamic = 'force-dynamic';

/**
 * The application.
 *
 * The chat is resolved on the server so the first paint already has the
 * participants and the peer's presence — the socket connects underneath and
 * takes over from there. `SocketProvider` is mounted here rather than in the
 * layout because it needs the chat id to join the room on connect.
 */
export default async function ChatPage(): Promise<React.JSX.Element> {
  // The layout already redirected an unauthenticated visitor; this is for the
  // type, and for the case where the session expires between the two.
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const chat = await getChatForUser(user.id);

  if (!chat) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState
          title="Waiting for the other person"
          description="This space opens once both authorized accounts have registered. Send them the link and ask them to sign up."
        />
      </div>
    );
  }

  return (
    <SocketProvider chatId={chat.id}>
      <ChatScreen chat={chat} />
    </SocketProvider>
  );
}
