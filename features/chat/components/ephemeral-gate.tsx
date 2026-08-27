'use client';

import { Eye, EyeOff, Flame, Timer } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { EphemeralSessionDTO, MessageDTO } from '@/types/models';
import { formatCountdown } from '@/utils/datetime';

/**
 * The seal in front of a view-once message.
 *
 * Content is not merely hidden behind this — the server does not send it until
 * `onOpen` reserves a look. Hiding it client-side would put the body in the
 * page for anyone with devtools, which would defeat the entire feature.
 *
 * Three states: sealed (never opened), open (a look is in progress), and spent
 * (gone for good). The sender always sees straight through — the gate is for
 * the recipient.
 */
export function EphemeralGate({
  message,
  mine,
  onOpen,
  children,
}: {
  message: MessageDTO;
  mine: boolean;
  onOpen: (message: MessageDTO) => Promise<EphemeralSessionDTO>;
  children: React.ReactNode;
}): React.JSX.Element {
  const ephemeral = message.ephemeral;
  const [opening, setOpening] = React.useState(false);
  const [remainingMs, setRemainingMs] = React.useState<number | null>(null);

  const destructAt = React.useMemo(() => {
    if (!ephemeral?.destructStartedAt || !ephemeral.destructAfterSeconds) return null;
    return new Date(ephemeral.destructStartedAt).getTime() + ephemeral.destructAfterSeconds * 1000;
  }, [ephemeral?.destructStartedAt, ephemeral?.destructAfterSeconds]);

  // The countdown is driven client-side so the number moves; the server's sweep
  // is what actually destroys the content, thirty seconds at a time.
  React.useEffect(() => {
    if (destructAt === null) return;

    const tick = (): void => setRemainingMs(Math.max(0, destructAt - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [destructAt]);

  // Not sealed at all, or the reader is the author: show the content.
  if (!ephemeral || mine || ephemeral.viewing) {
    return (
      <div className="relative">
        {children}
        {destructAt !== null && remainingMs !== null && remainingMs > 0 ? (
          <span className="mt-1 flex items-center gap-1 text-[0.6875rem] opacity-75">
            <Timer className="size-3" aria-hidden />
            {formatCountdown(remainingMs)}
          </span>
        ) : null}
      </div>
    );
  }

  if (ephemeral.consumed) {
    return (
      <p className="flex items-center gap-1.5 py-1 text-sm italic opacity-70">
        <Flame className="size-3.5" aria-hidden />
        This message is gone
      </p>
    );
  }

  const exhausted = ephemeral.remainingViews !== null && ephemeral.remainingViews <= 0;

  const handleOpen = async (): Promise<void> => {
    if (opening || exhausted) return;
    setOpening(true);
    try {
      await onOpen(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open this message');
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleOpen()}
      disabled={opening || exhausted}
      aria-label={
        exhausted ? 'No views left for this message' : 'Open this message — it can only be viewed once'
      }
      className={cn(
        'flex min-w-48 items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-left',
        'bg-current/10 transition-colors',
        exhausted ? 'cursor-not-allowed opacity-60' : 'hover:bg-current/15',
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-current/15">
        {opening ? (
          <Spinner className="size-4" />
        ) : exhausted ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </span>

      <span className="min-w-0">
        <span className="block text-sm font-medium">
          {exhausted ? 'No views left' : opening ? 'Opening…' : 'Tap to view'}
        </span>
        <span className="block text-xs opacity-70">
          {ephemeral.remainingViews === null
            ? 'Disappears after viewing'
            : `${ephemeral.remainingViews} view${ephemeral.remainingViews === 1 ? '' : 's'} left`}
        </span>
      </span>
    </button>
  );
}
