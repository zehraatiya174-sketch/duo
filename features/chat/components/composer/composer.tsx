'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Flame, Paperclip, Send, Smile, Video, X } from 'lucide-react';
import * as React from 'react';

import { usePreferences } from '@/components/providers/preferences-provider';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Hint } from '@/components/ui/tooltip';
import { useUploader } from '@/hooks/use-uploader';
import { fadeUp } from '@/lib/motion';
import { cn, truncate } from '@/lib/utils';
import type { MessageDTO } from '@/types/models';
import type { SendMessagePayload } from '@/types/socket';

import { AttachmentTray } from './attachment-tray';
import { CameraCapture } from './camera-capture';

export interface ComposerProps {
  disabled?: boolean;
  replyTo: MessageDTO | null;
  onCancelReply: () => void;
  onTyping: (typing: boolean) => void;
  onSend: (input: {
    body: string;
    attachmentIds: string[];
    ephemeral?: SendMessagePayload['ephemeral'];
  }) => void | Promise<void>;
}

/** How long after the last keystroke the typing indicator is retracted. */
const TYPING_IDLE_MS = 2_500;

/**
 * The message input.
 *
 * Attachments upload the moment they are chosen rather than on send, so by the
 * time a caption is typed the bytes are usually already on the server and
 * sending feels instant even for a large photo. That is why `onSend` takes
 * attachment *ids* — the upload has already happened.
 */
export function Composer({
  disabled = false,
  replyTo,
  onCancelReply,
  onTyping,
  onSend,
}: ComposerProps): React.JSX.Element {
  const { settings } = usePreferences();
  const uploader = useUploader();

  const [body, setBody] = React.useState('');
  const [sealed, setSealed] = React.useState(false);
  const [cameraOpen, setCameraOpen] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const typingTimer = React.useRef<number | null>(null);
  const typingActive = React.useRef(false);

  const canSend = (body.trim().length > 0 || uploader.ready.length > 0) && !uploader.busy;

  /**
   * Typing is announced on the first keystroke and retracted after a pause,
   * rather than emitted per key. The socket handler is cheap but the other
   * person's indicator flickering on every character is not.
   */
  const signalTyping = React.useCallback((): void => {
    if (!typingActive.current) {
      typingActive.current = true;
      onTyping(true);
    }

    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      typingActive.current = false;
      onTyping(false);
    }, TYPING_IDLE_MS);
  }, [onTyping]);

  const stopTyping = React.useCallback((): void => {
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    if (typingActive.current) {
      typingActive.current = false;
      onTyping(false);
    }
  }, [onTyping]);

  React.useEffect(() => stopTyping, [stopTyping]);

  // Focusing on reply is the whole point of tapping reply.
  React.useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  const submit = async (): Promise<void> => {
    if (!canSend || disabled) return;

    const text = body.trim();
    const attachmentIds = uploader.ready.map((attachment) => attachment.id);

    // Cleared before awaiting: the send is optimistic, and a composer that
    // stayed full until the server answered would invite a double send.
    setBody('');
    uploader.clear();
    stopTyping();

    await onSend({
      body: text,
      attachmentIds,
      ...(sealed ? { ephemeral: { mode: 'VIEW_ONCE' as const } } : {}),
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends only when the preference says so; Shift+Enter is always a
    // newline, and on touch keyboards Enter is always a newline.
    if (event.key === 'Enter' && !event.shiftKey && settings.enterToSend) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: React.ClipboardEvent): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void uploader.add(files);
  };

  return (
    <div className="glass border-t border-[var(--hairline)]">
      <AnimatePresence>
        {replyTo ? (
          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2"
          >
            <span className="h-8 w-0.5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-[var(--accent)]">Replying to</span>
              <span className="block truncate text-xs text-[var(--text-muted)]">
                {replyTo.body ? truncate(replyTo.body, 80) : 'Attachment'}
              </span>
            </span>
            <Button variant="ghost" size="icon-sm" onClick={onCancelReply} aria-label="Cancel reply">
              <X />
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AttachmentTray
        drafts={uploader.drafts}
        onRetry={uploader.retry}
        onRemove={uploader.remove}
      />

      <div className="flex items-end gap-1 p-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files;
            if (files) void uploader.add(Array.from(files));
            // Reset so picking the same file twice in a row still fires.
            event.target.value = '';
          }}
        />

        <Hint label="Attach">
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach a file"
          >
            <Paperclip />
          </Button>
        </Hint>

        <Hint label="Record a video">
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => setCameraOpen(true)}
            aria-label="Record a video"
          >
            <Video />
          </Button>
        </Hint>

        <Textarea
          ref={textareaRef}
          value={body}
          disabled={disabled}
          autoResize
          maxRows={8}
          placeholder={sealed ? 'Send a message that disappears…' : 'Message'}
          aria-label="Message"
          onChange={(event) => {
            setBody(event.target.value);
            signalTyping();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={stopTyping}
          className="min-h-10 flex-1 border-transparent bg-[var(--surface-sunken)]"
        />

        <Hint label={sealed ? 'Disappearing: on' : 'Send once, then destroy'}>
          <Button
            variant={sealed ? 'primary' : 'ghost'}
            size="icon"
            disabled={disabled}
            onClick={() => setSealed((current) => !current)}
            aria-pressed={sealed}
            aria-label="Toggle disappearing message"
          >
            <Flame />
          </Button>
        </Hint>

        <Button
          variant="primary"
          size="icon"
          disabled={!canSend || disabled}
          loading={uploader.busy}
          onClick={() => void submit()}
          aria-label="Send"
          className={cn(!canSend && 'opacity-50')}
        >
          <Send />
        </Button>
      </div>

      <CameraCapture
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={(file, extras) => {
          void uploader.add([file], extras ?? {});
        }}
      />
    </div>
  );
}
