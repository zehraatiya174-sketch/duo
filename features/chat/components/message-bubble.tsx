'use client';

import { motion } from 'framer-motion';
import { Pencil, Pin, RotateCcw, Trash2 } from 'lucide-react';
import * as React from 'react';

import { usePreferences } from '@/components/providers/preferences-provider';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Hint } from '@/components/ui/tooltip';
import { messageEnter } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { EphemeralSessionDTO, MessageDTO, PublicProfile } from '@/types/models';
import { formatClock, formatFull } from '@/utils/datetime';

import { AttachmentList } from './attachments/attachment-list';
import { EphemeralGate } from './ephemeral-gate';
import { LinkPreviewCard } from './link-preview-card';
import { LocationCard } from './location-card';
import { MessageActions, type MessageActionHandlers } from './message-actions';
import { MessageSeenLabel } from './message-status';
import { ReactionRow } from './reaction-row';
import { ReplyQuote } from './reply-quote';
import { RichText } from './rich-text';

export interface MessageBubbleProps {
  message: MessageDTO;
  mine: boolean;
  author: PublicProfile | null;
  participants: PublicProfile[];
  /** False when the previous message is from the same author in the same minute. */
  showAuthor: boolean;
  /** True for the last message in a run — only that one gets the tail. */
  showTail: boolean;
  /**
   * True for the newest message the local user sent. Only that one carries a
   * "Seen …" line; older outgoing messages say nothing about delivery.
   */
  isLatestOutgoing: boolean;
  highlighted: boolean;
  editing: boolean;
  handlers: MessageActionHandlers;
  onEditSubmit: (body: string) => void;
  onEditCancel: () => void;
  onJump: (messageId: string) => void;
  onOpenEphemeral: (message: MessageDTO) => Promise<EphemeralSessionDTO>;
  onRetry: () => void;
  onDiscard: () => void;
}

/**
 * One message.
 *
 * Memoised on identity: the timeline re-renders on every socket event, and a
 * conversation with hundreds of mounted bubbles cannot afford to re-render all
 * of them because one reaction changed.
 */
export const MessageBubble = React.memo(function MessageBubble({
  message,
  mine,
  author,
  participants,
  showAuthor,
  showTail,
  isLatestOutgoing,
  highlighted,
  editing,
  handlers,
  onEditSubmit,
  onEditCancel,
  onJump,
  onOpenEphemeral,
  onRetry,
  onDiscard,
}: MessageBubbleProps): React.JSX.Element {
  const { settings } = usePreferences();
  const [draft, setDraft] = React.useState(message.body ?? '');

  React.useEffect(() => {
    if (editing) setDraft(message.body ?? '');
  }, [editing, message.body]);

  const failed = message.status === 'FAILED';
  const ephemeral = message.ephemeral !== null && message.ephemeral.mode !== 'NORMAL';

  // Disappearing media loses the affordances that would let it be kept.
  const allowDownload = !ephemeral;
  const protectedMedia = ephemeral || settings.screenshotWarnings;

  const body =
    message.type === 'CODE' && message.body
      ? `\`\`\`${message.codeLanguage ?? ''}\n${message.body}\n\`\`\``
      : message.body;

  const onEditKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEditCancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onEditSubmit(draft);
    }
  };

  return (
    <motion.div
      layout="position"
      variants={messageEnter(mine)}
      initial="hidden"
      animate="visible"
      className={cn(
        'group/message flex w-full gap-2 px-2 sm:px-4',
        mine ? 'flex-row-reverse' : 'flex-row',
        showTail ? 'mb-2' : 'mb-0.5',
      )}
    >
      <div className="w-8 shrink-0 self-end">
        {showTail && !mine ? (
          <Avatar size="sm" name={author?.displayName ?? 'Unknown'} src={author?.avatarUrl} />
        ) : null}
      </div>

      <div
        className={cn(
          'flex max-w-[min(38rem,78%)] min-w-0 flex-col gap-1',
          mine ? 'items-end' : 'items-start',
        )}
      >
        {showAuthor && !mine ? (
          <span className="px-1 text-xs font-medium text-[var(--text-secondary)]">
            {author?.displayName ?? 'Unknown'}
          </span>
        ) : null}

        <div className={cn('flex items-center gap-1', mine ? 'flex-row-reverse' : 'flex-row')}>
          <div
            data-message-bubble
            className={cn(
              'relative min-w-0 rounded-[var(--radius-xl)] px-3 py-2 text-sm shadow-[var(--shadow-lift)] transition-[box-shadow,background-color] duration-200',
              mine
                ? 'bg-[image:var(--bubble-mine)] text-white'
                : 'glass text-[var(--text-primary)]',
              showTail &&
                (mine ? 'rounded-br-[var(--radius-xs)]' : 'rounded-bl-[var(--radius-xs)]'),
              highlighted &&
                'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--canvas)]',
              failed && 'ring-1 ring-[var(--color-danger)]',
            )}
          >
            {message.pinned ? (
              <Hint label="Pinned">
                <span
                  className={cn(
                    'absolute -top-1.5 flex size-5 items-center justify-center rounded-full',
                    'bg-[var(--accent)] text-white shadow-[var(--shadow-lift)]',
                    mine ? '-left-1.5' : '-right-1.5',
                  )}
                >
                  <Pin className="size-2.5" aria-label="Pinned" />
                </span>
              </Hint>
            ) : null}

            {message.forwardedFrom ? (
              <ReplyQuote reference={message.forwardedFrom} variant="forward" className="mb-1.5" />
            ) : null}

            {message.replyTo ? (
              <ReplyQuote reference={message.replyTo} onJump={onJump} className="mb-1.5" />
            ) : null}

            {message.deletedForAll ? (
              <p className="flex items-center gap-1.5 py-0.5 text-sm italic opacity-70">
                <Trash2 className="size-3.5" aria-hidden />
                This message was deleted
              </p>
            ) : editing ? (
              <div className="min-w-[16rem] space-y-2">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onEditKeyDown}
                  autoResize
                  maxRows={10}
                  autoFocus
                  aria-label="Edit message"
                  className="bg-white/10 text-inherit"
                />
                <div className="flex justify-end gap-1">
                  <Button size="xs" variant="ghost" onClick={onEditCancel}>
                    Cancel
                  </Button>
                  <Button size="xs" variant="secondary" onClick={() => onEditSubmit(draft)}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <EphemeralGate message={message} mine={mine} onOpen={onOpenEphemeral}>
                <div className="space-y-1.5">
                  {message.attachments.length > 0 ? (
                    <AttachmentList
                      attachments={message.attachments}
                      mine={mine}
                      allowDownload={allowDownload}
                      protectedMedia={protectedMedia}
                      blurred={settings.blurNsfwPreviews && !mine}
                    />
                  ) : null}

                  {body ? (
                    <RichText
                      body={body}
                      mentions={message.mentions}
                      selfId={mine ? message.authorId : ''}
                      mine={mine}
                    />
                  ) : null}

                  {message.location ? <LocationCard location={message.location} /> : null}

                  {message.linkPreviews.map((preview) => (
                    <LinkPreviewCard key={preview.id} preview={preview} />
                  ))}
                </div>
              </EphemeralGate>
            )}

            <div
              className={cn(
                'mt-0.5 flex items-center justify-end gap-1 text-[0.625rem]',
                mine ? 'text-white/70' : 'text-[var(--text-muted)]',
              )}
            >
              {message.editedAt ? (
                <Hint label={`Edited ${formatFull(message.editedAt)}`}>
                  <span className="flex items-center gap-0.5">
                    <Pencil className="size-2.5" aria-hidden />
                    edited
                  </span>
                </Hint>
              ) : null}

              <Hint label={formatFull(message.createdAt)}>
                <time dateTime={message.createdAt} className="tabular-nums">
                  {formatClock(message.createdAt)}
                </time>
              </Hint>
            </div>
          </div>

          {!editing ? <MessageActions message={message} mine={mine} handlers={handlers} /> : null}
        </div>

        <ReactionRow
          reactions={message.reactions}
          participants={participants}
          mine={mine}
          onToggle={handlers.onReact}
        />

        {mine && isLatestOutgoing && !failed ? (
          <MessageSeenLabel readAt={message.readAt} />
        ) : null}

        {failed ? (
          <div className="flex items-center gap-2 px-1 text-[0.6875rem] text-[var(--color-danger)]">
            <span>Not delivered</span>
            <Button size="xs" variant="ghost" onClick={onRetry}>
              <RotateCcw className="size-3" />
              Retry
            </Button>
            <Button size="xs" variant="ghost" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
});
