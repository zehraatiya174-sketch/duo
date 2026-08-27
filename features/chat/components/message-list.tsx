'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { fadeUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { EphemeralSessionDTO, MessageDTO, PublicProfile } from '@/types/models';
import { isSameDayAs } from '@/utils/datetime';

import { DateSeparator } from './date-separator';
import { MessageBubble } from './message-bubble';
import type { MessageActionHandlers } from './message-actions';
import { TypingIndicator } from './typing-indicator';

/** Rows are messages plus the separators woven between them. */
type Row =
  | { kind: 'day'; key: string; date: string }
  | { kind: 'unread'; key: string; count: number }
  | {
      kind: 'message';
      key: string;
      message: MessageDTO;
      showAuthor: boolean;
      showTail: boolean;
    };

/** Distance from the bottom within which the view is considered "at the end". */
const STICK_THRESHOLD_PX = 120;

/** Rows to render beyond the viewport, in each direction. */
const OVERSCAN = 10;

/** Messages from the same author within this window are visually grouped. */
const GROUP_WINDOW_MS = 3 * 60_000;

function buildRows(messages: MessageDTO[], unreadCount: number, selfId: string): Row[] {
  const rows: Row[] = [];
  // The unread marker sits above the first message the reader has not seen.
  const firstUnreadIndex =
    unreadCount > 0
      ? Math.max(
          0,
          messages.length -
            messages.slice(-unreadCount).filter((message) => message.authorId !== selfId).length,
        )
      : -1;

  messages.forEach((message, index) => {
    const previous = index > 0 ? messages[index - 1] : undefined;
    const next = index < messages.length - 1 ? messages[index + 1] : undefined;

    if (!previous || !isSameDayAs(previous.createdAt, message.createdAt)) {
      rows.push({ kind: 'day', key: `day-${message.id}`, date: message.createdAt });
    }

    if (index === firstUnreadIndex && firstUnreadIndex > 0 && unreadCount > 0) {
      rows.push({ kind: 'unread', key: 'unread-marker', count: unreadCount });
    }

    const startsRun =
      !previous ||
      previous.authorId !== message.authorId ||
      !isSameDayAs(previous.createdAt, message.createdAt) ||
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() >
        GROUP_WINDOW_MS;

    const endsRun =
      !next ||
      next.authorId !== message.authorId ||
      !isSameDayAs(next.createdAt, message.createdAt) ||
      new Date(next.createdAt).getTime() - new Date(message.createdAt).getTime() > GROUP_WINDOW_MS;

    rows.push({
      kind: 'message',
      key: message.id,
      message,
      showAuthor: startsRun,
      showTail: endsRun,
    });
  });

  return rows;
}

export interface MessageListProps {
  messages: MessageDTO[];
  selfId: string;
  participants: PublicProfile[];
  peer: PublicProfile | null;
  unreadCount: number;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  loadOlder: () => void;
  peerTyping: boolean;
  highlightedId: string | null;
  editingId: string | null;
  buildHandlers: (message: MessageDTO) => MessageActionHandlers;
  onEditSubmit: (message: MessageDTO, body: string) => void;
  onEditCancel: () => void;
  onJump: (messageId: string) => void;
  onOpenEphemeral: (message: MessageDTO) => Promise<EphemeralSessionDTO>;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
  /** Called with each message id as it becomes visible. */
  onVisible: (messageId: string) => void;
  /** Hands the scroll-to-message function back to the runtime. */
  registerScroller: (scroller: (messageId: string) => boolean) => void;
}

/**
 * The conversation timeline.
 *
 * Virtualised because a long conversation would otherwise hold thousands of
 * mounted bubbles, each with its own listeners and media elements. Row heights
 * are measured rather than estimated — a message can be one line or a photo
 * album, and a wrong estimate shows up immediately as scroll drift.
 */
export function MessageList({
  messages,
  selfId,
  participants,
  peer,
  unreadCount,
  loading,
  loadingOlder,
  hasOlder,
  loadOlder,
  peerTyping,
  highlightedId,
  editingId,
  buildHandlers,
  onEditSubmit,
  onEditCancel,
  onJump,
  onOpenEphemeral,
  onRetry,
  onDiscard,
  onVisible,
  registerScroller,
}: MessageListProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = React.useState(true);
  const [newBelow, setNewBelow] = React.useState(0);

  const rows = React.useMemo(
    () => buildRows(messages, unreadCount, selfId),
    [messages, unreadCount, selfId],
  );

  // Only the newest thing the local user said reports whether it was seen, so
  // the timeline — not the bubble — is what decides which one that is.
  const latestOutgoingId = React.useMemo(
    () => messages.findLast((message) => message.authorId === selfId)?.id ?? null,
    [messages, selfId],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // A generous default: under-estimating makes the scrollbar jump as real
    // heights arrive, and most rows are taller than a single line.
    estimateSize: () => 76,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

  // --- Scroll position management -----------------------------------------

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'auto'): void => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const onScroll = React.useCallback((): void => {
    const element = scrollRef.current;
    if (!element) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom < STICK_THRESHOLD_PX;

    setStuckToBottom(atBottom);
    if (atBottom) setNewBelow(0);

    // Reaching the top pulls in the previous page.
    if (element.scrollTop < 300 && hasOlder && !loadingOlder) {
      loadOlder();
    }
  }, [hasOlder, loadingOlder, loadOlder]);

  // Preserve the reading position when a page is prepended above.
  const previousHeight = React.useRef(0);
  const previousCount = React.useRef(0);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const grewAtTop = rows.length > previousCount.current && !stuckToBottom;
    if (grewAtTop && previousHeight.current > 0) {
      element.scrollTop += element.scrollHeight - previousHeight.current;
    }

    previousHeight.current = element.scrollHeight;
    previousCount.current = rows.length;
  }, [rows.length, stuckToBottom]);

  // Follow the conversation while the reader is at the end; otherwise count
  // what arrived so the jump control can say how much was missed.
  const lastMessageId = messages.at(-1)?.id;
  React.useEffect(() => {
    if (!lastMessageId) return;
    if (stuckToBottom) {
      scrollToBottom('smooth');
    } else {
      setNewBelow((count) => count + 1);
    }
    // Only a genuinely new last message should move the view; re-running on
    // `stuckToBottom` would scroll the reader away mid-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessageId]);

  // Land at the newest message on first load rather than animating down to it.
  const primed = React.useRef(false);
  React.useLayoutEffect(() => {
    if (primed.current || loading || messages.length === 0) return;
    primed.current = true;
    scrollToBottom('auto');
  }, [loading, messages.length, scrollToBottom]);

  // --- Jump to message -----------------------------------------------------

  const scrollToMessage = React.useCallback(
    (messageId: string): boolean => {
      const index = rows.findIndex((row) => row.kind === 'message' && row.message.id === messageId);
      if (index === -1) return false;
      virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
      return true;
    },
    [rows, virtualizer],
  );

  React.useEffect(() => {
    registerScroller(scrollToMessage);
  }, [registerScroller, scrollToMessage]);

  // --- Read receipts -------------------------------------------------------

  const observerRef = React.useRef<IntersectionObserver | null>(null);
  const onVisibleRef = React.useRef(onVisible);
  onVisibleRef.current = onVisible;

  React.useEffect(() => {
    const root = scrollRef.current;
    // There is no scroll container while the timeline is showing skeletons, so
    // this has to run again once one exists — which is what `loading` is doing
    // in the dependencies. With an empty dependency list the observer was only
    // ever attempted on the first commit, when the container is still absent on
    // a cold load, and read receipts were then never reported for the rest of
    // the session: the reader saw everything and the sender was never told.
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.getAttribute('data-message-id');
          if (id) onVisibleRef.current(id);
        }
      },
      // Half the row must be on screen: a message clipped by the composer has
      // not really been read.
      { root, threshold: 0.5 },
    );

    observerRef.current = observer;

    // Rows mount in the same commit as the container, so `measureRow` has
    // already run for everything currently on screen — with no observer yet to
    // hand those nodes to. They are the newest messages, the ones whose receipt
    // actually matters, so they are collected here instead of waiting for a
    // scroll to remount them.
    for (const node of root.querySelectorAll('[data-message-id]')) observer.observe(node);

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [loading]);

  const measureRow = React.useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) return;
      virtualizer.measureElement(node);
      if (node.getAttribute('data-message-id')) observerRef.current?.observe(node);
    },
    [virtualizer],
  );

  // --- Render --------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex-1 space-y-3 overflow-hidden px-4 py-6">
        {Array.from({ length: 7 }, (_, index) => (
          <div
            key={index}
            className={cn('flex', index % 3 === 0 ? 'justify-end' : 'justify-start')}
          >
            <Skeleton
              className="h-14 rounded-[var(--radius-xl)]"
              style={{ width: `${38 + ((index * 37) % 34)}%` }}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="anchor-bottom h-full overflow-y-auto overscroll-contain scroll-smooth py-4"
      >
        {hasOlder ? (
          <div className="flex justify-center py-3">
            {loadingOlder ? (
              <Spinner className="size-5 text-[var(--text-muted)]" />
            ) : (
              <Button variant="ghost" size="sm" onClick={loadOlder}>
                Load earlier messages
              </Button>
            )}
          </div>
        ) : messages.length > 0 ? (
          <p className="px-6 pb-4 text-center text-xs text-[var(--text-muted)]">
            This is the beginning of your conversation.
          </p>
        ) : null}

        {messages.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description={
              peer
                ? `Say something to ${peer.displayName}. Everything here stays between the two of you.`
                : 'Say something. Everything here stays between the two of you.'
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;

              return (
                <div
                  key={item.key}
                  ref={measureRow}
                  data-index={item.index}
                  {...(row.kind === 'message' ? { 'data-message-id': row.message.id } : {})}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {row.kind === 'day' ? <DateSeparator date={row.date} /> : null}

                  {row.kind === 'unread' ? (
                    <div className="my-3 flex items-center gap-3 px-4">
                      <span className="h-px flex-1 bg-[var(--accent)]/40" />
                      <span className="text-[0.6875rem] font-semibold tracking-wider text-[var(--accent)] uppercase">
                        {row.count} unread
                      </span>
                      <span className="h-px flex-1 bg-[var(--accent)]/40" />
                    </div>
                  ) : null}

                  {row.kind === 'message' ? (
                    <MessageBubble
                      message={row.message}
                      mine={row.message.authorId === selfId}
                      author={
                        participants.find((person) => person.userId === row.message.authorId) ??
                        null
                      }
                      participants={participants}
                      showAuthor={row.showAuthor}
                      showTail={row.showTail}
                      isLatestOutgoing={row.message.id === latestOutgoingId}
                      highlighted={highlightedId === row.message.id}
                      editing={editingId === row.message.id}
                      handlers={buildHandlers(row.message)}
                      onEditSubmit={(body) => onEditSubmit(row.message, body)}
                      onEditCancel={onEditCancel}
                      onJump={onJump}
                      onOpenEphemeral={onOpenEphemeral}
                      onRetry={() => onRetry(row.message.clientId)}
                      onDiscard={() => onDiscard(row.message.clientId)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <AnimatePresence>
          {peerTyping && peer ? (
            <motion.div
              key="typing"
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="px-4 pt-1"
            >
              <TypingIndicator profile={peer} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {!stuckToBottom ? (
          <motion.div
            key="jump"
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute right-4 bottom-4 z-20"
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                scrollToBottom('smooth');
                setNewBelow(0);
              }}
              className="glass-strong rounded-full shadow-[var(--shadow-float)]"
            >
              <ArrowDown className="size-4" />
              {newBelow > 0 ? `${newBelow} new` : 'Latest'}
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
