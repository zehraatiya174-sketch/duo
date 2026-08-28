'use client';

import {
  Copy,
  CornerUpRight,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Smile,
  Trash2,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { MessageDTO } from '@/types/models';

/** Quick reactions offered without opening a picker. */
const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🙏'] as const;

export interface MessageActionHandlers {
  onReply: () => void;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: (scope: 'me' | 'everyone') => void;
  onPin: (pinned: boolean) => void;
  onForward: () => void;
}

/**
 * The hover toolbar and overflow menu on a message.
 *
 * Which actions exist is decided here rather than by the caller, because the
 * rules are properties of the message: only the author may edit, editing closes
 * after a window, and a deleted or sealed message has almost no actions at all.
 * The server re-checks every one of these — this is affordance, not access
 * control.
 */
export function MessageActions({
  message,
  mine,
  handlers,
}: {
  message: MessageDTO;
  mine: boolean;
  handlers: MessageActionHandlers;
}): React.JSX.Element | null {
  const gone = message.deletedForAll;
  const sealed = message.ephemeral !== null && !mine;

  // Nothing meaningful can be done to a tombstone.
  if (gone) return null;

  const canCopy = Boolean(message.body) && !sealed;
  // Editing a sealed message would change content the recipient may already
  // have spent their only look on.
  const canEdit = mine && message.type !== 'LOCATION' && message.ephemeral === null;

  const copy = async (): Promise<void> => {
    if (!message.body) return;
    try {
      await navigator.clipboard.writeText(message.body);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access');
    }
  };

  // The bubble declares a *named* group (`group/message`), so the modifier has
  // to name it too — a bare `group-hover:` never matches and the toolbar stays
  // invisible forever, which is exactly what it was doing.
  //
  // And hover does not exist on a touch screen. The toolbar is therefore
  // visible by default and only hidden on devices that can actually hover, so a
  // phone shows reply/edit/delete rather than hiding them behind a gesture that
  // cannot happen.
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 transition-opacity',
        'opacity-100 [@media(hover:hover)]:opacity-0',
        '[@media(hover:hover)]:group-hover/message:opacity-100',
        'focus-within:opacity-100',
      )}
    >
      <DropdownMenu>
        <Hint label="React">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Add a reaction">
              <Smile />
            </Button>
          </DropdownMenuTrigger>
        </Hint>

        <DropdownMenuContent align={mine ? 'end' : 'start'} className="flex min-w-0 gap-0.5 p-1">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => handlers.onReact(emoji)}
              aria-label={`React with ${emoji}`}
              className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-lg transition-transform hover:scale-110 hover:bg-[var(--surface-sunken)]"
            >
              {emoji}
            </button>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Hint label="Reply">
        <Button variant="ghost" size="icon-sm" onClick={handlers.onReply} aria-label="Reply">
          <Reply />
        </Button>
      </Hint>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align={mine ? 'end' : 'start'}>
          {canCopy ? (
            <DropdownMenuItem onSelect={() => void copy()}>
              <Copy />
              Copy text
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuItem onSelect={handlers.onForward}>
            <CornerUpRight />
            Forward
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => handlers.onPin(!message.pinned)}>
            {message.pinned ? <PinOff /> : <Pin />}
            {message.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>

          {canEdit ? (
            <DropdownMenuItem onSelect={handlers.onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSeparator />

          <DropdownMenuItem destructive onSelect={() => handlers.onDelete('me')}>
            <Trash2 />
            Delete for me
          </DropdownMenuItem>

          {mine ? (
            <DropdownMenuItem destructive onSelect={() => handlers.onDelete('everyone')}>
              <Trash2 />
              Delete for everyone
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
