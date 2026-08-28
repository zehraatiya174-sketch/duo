'use client';

import { Phone, Video } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { useSessionUser } from '@/components/providers/session-provider';
import { useSocket } from '@/components/providers/socket-provider';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { CallOverlay } from '@/features/calls/components/call-overlay';
import { useCall } from '@/hooks/use-call';
import { useMessages } from '@/hooks/use-messages';
import { useMessageSender } from '@/hooks/use-message-sender';
import { useReadReceipts } from '@/hooks/use-read-receipts';
import { useRealtime } from '@/hooks/use-realtime';
import { messageTypeFor } from '@/lib/messages/optimistic';
import { cn } from '@/lib/utils';
import type {
  AttachmentDTO,
  ChatSummaryDTO,
  EphemeralSessionDTO,
  MessageDTO,
} from '@/types/models';
import { formatLastSeen } from '@/utils/datetime';

import { Composer } from './composer/composer';
import { MessageList } from './message-list';
import type { MessageActionHandlers } from './message-actions';
import { UserMenu } from './user-menu';

/**
 * The conversation.
 *
 * This is where the pieces meet: the query cache holds the timeline, the socket
 * patches it, the sender writes to it optimistically, and everything below is
 * presentation. Orchestrating here rather than in a context provider keeps the
 * data flow readable in one file — there is exactly one conversation and one
 * consumer, so a provider would add indirection without adding reuse.
 */
export function ChatScreen({ chat }: { chat: ChatSummaryDTO }): React.JSX.Element {
  const self = useSessionUser();
  const { status, request, emit } = useSocket();

  const [replyTo, setReplyTo] = React.useState<MessageDTO | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);

  const scrollerRef = React.useRef<((messageId: string) => boolean) | null>(null);

  const peer = React.useMemo(
    () => chat.participants.find((profile) => profile.userId !== self.id) ?? null,
    [chat.participants, self.id],
  );

  const { messages, query, loadOlder, hasOlder, loadingOlder } = useMessages(chat.id);
  const sender = useMessageSender(chat.id, self.id);
  const call = useCall(chat.id, self.id);

  // Receipts are only reported while the tab is actually being looked at;
  // marking messages read in a background tab would be a lie.
  const [focused, setFocused] = React.useState(true);
  React.useEffect(() => {
    const onVisibility = (): void => setFocused(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const receipts = useReadReceipts(chat.id, focused);

  const realtime = useRealtime({
    chatId: chat.id,
    selfId: self.id,
    onNotification: (notification) => {
      // A toast only when the conversation is not already on screen.
      if (!focused) toast(notification.title, { description: notification.body ?? undefined });
    },
  });

  const jumpTo = React.useCallback((messageId: string): void => {
    const found = scrollerRef.current?.(messageId);
    if (!found) {
      toast('That message is further back', {
        description: 'Scroll up to load more of the conversation.',
      });
      return;
    }
    setHighlightedId(messageId);
    window.setTimeout(() => setHighlightedId(null), 1600);
  }, []);

  /**
   * Opening a sealed message.
   *
   * Goes over the socket rather than HTTP because the reservation, the render
   * confirmation and the settlement all belong to one short-lived session, and
   * the socket is the only transport that can carry the closing half.
   */
  const openEphemeral = React.useCallback(
    async (message: MessageDTO): Promise<EphemeralSessionDTO> => {
      return request('ephemeral:open', { messageId: message.id });
    },
    [request],
  );

  const buildHandlers = React.useCallback(
    (message: MessageDTO): MessageActionHandlers => ({
      onReply: () => setReplyTo(message),
      onReact: (emoji) => {
        void request('message:react', { messageId: message.id, emoji }).catch(() =>
          toast.error('Could not add that reaction'),
        );
      },
      onEdit: () => setEditingId(message.id),
      onDelete: (scope) => {
        void request('message:delete', { messageId: message.id, scope }).catch(() =>
          toast.error('Could not delete that message'),
        );
      },
      onPin: (pinned) => {
        void request('message:pin', { messageId: message.id, pinned }).catch(() =>
          toast.error('Could not pin that message'),
        );
      },
      onForward: () => toast('Forwarding is not wired up yet'),
    }),
    [request],
  );

  const onEditSubmit = React.useCallback(
    (message: MessageDTO, body: string): void => {
      setEditingId(null);
      void request('message:edit', { messageId: message.id, body }).catch(() =>
        toast.error('Could not save that edit'),
      );
    },
    [request],
  );

  const send = React.useCallback(
    async (input: {
      body: string;
      attachments: AttachmentDTO[];
      ephemeral?: Parameters<typeof sender.send>[0]['ephemeral'];
    }): Promise<void> => {
      await sender.send({
        type: messageTypeFor(input.attachments),
        body: input.body || undefined,
        replyTo,
        attachments: input.attachments,
        ephemeral: input.ephemeral,
      });

      setReplyTo(null);
    },
    [sender, replyTo],
  );

  const presenceLabel =
    peer?.presence === 'ONLINE'
      ? 'Online'
      : peer
        ? formatLastSeen(peer.lastSeenAt)
        : 'No one else here yet';

  return (
    <div className="flex h-full flex-col">
      <header className="glass flex items-center gap-3 border-b border-[var(--hairline)] px-3 py-2">
        <Avatar size="sm" name={peer?.displayName ?? 'Duo'} src={peer?.avatarUrl ?? null} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {chat.title ?? peer?.displayName ?? 'Duo'}
          </p>
          <p
            className={cn(
              'truncate text-xs',
              status !== 'connected'
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--text-muted)]',
            )}
          >
            {status === 'connected'
              ? realtime.peerTyping
                ? 'typing…'
                : presenceLabel
              : status === 'reconnecting'
                ? 'Reconnecting…'
                : status === 'connecting'
                  ? 'Connecting…'
                  : 'Offline'}
          </p>
        </div>

        <Hint label="Voice call">
          <Button
            variant="ghost"
            size="icon"
            disabled={!peer || status !== 'connected'}
            onClick={() => void call.start('AUDIO')}
            aria-label="Start a voice call"
          >
            <Phone />
          </Button>
        </Hint>

        <Hint label="Video call">
          <Button
            variant="ghost"
            size="icon"
            disabled={!peer || status !== 'connected'}
            onClick={() => void call.start('VIDEO')}
            aria-label="Start a video call"
          >
            <Video />
          </Button>
        </Hint>

        {/* Your own account: settings, the admin console, and sign out. */}
        <span className="ml-1 shrink-0">
          <UserMenu />
        </span>
      </header>

      <MessageList
        messages={messages}
        selfId={self.id}
        participants={chat.participants}
        peer={peer}
        unreadCount={chat.unreadCount}
        loading={query.isLoading}
        loadingOlder={loadingOlder}
        hasOlder={hasOlder}
        loadOlder={loadOlder}
        peerTyping={realtime.peerTyping}
        highlightedId={highlightedId}
        editingId={editingId}
        buildHandlers={buildHandlers}
        onEditSubmit={onEditSubmit}
        onEditCancel={() => setEditingId(null)}
        onJump={jumpTo}
        onOpenEphemeral={openEphemeral}
        onRetry={(clientId) => void sender.retry(clientId)}
        onDiscard={sender.discard}
        onVisible={receipts.observe}
        registerScroller={(scroller) => {
          scrollerRef.current = scroller;
        }}
      />

      <Composer
        disabled={status === 'offline'}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onTyping={(typing) => emit('typing:set', { chatId: chat.id, typing })}
        onSend={send}
      />

      {call.session ? (
        <CallOverlay
          session={call.session}
          peer={peer}
          localStream={call.localStream}
          remoteStream={call.remoteStream}
          hasTurn={call.hasTurn}
          onToggleMic={call.toggleMic}
          onToggleCamera={() => void call.toggleCamera()}
          onToggleScreenShare={() => void call.toggleScreenShare()}
          onHangUp={() => call.hangUp()}
        />
      ) : null}
    </div>
  );
}
