'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Friction against casual copying of protected media.
 *
 * This blocks the context menu, drag-to-save and the selection handles. It is
 * honest to say what it is not: a browser cannot prevent a screenshot, a
 * screen recording, or a photograph of the monitor, and anyone willing to open
 * devtools can reach the same bytes the page reached. What this does is stop
 * media leaving by accident or by the obvious one-click routes, which is the
 * whole of what a web client can offer. Real protection is the short-lived,
 * user-bound signed URL and the server-side ephemeral gate behind it.
 */
export function MediaGuard({
  enabled = true,
  className,
  children,
}: {
  enabled?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const block = React.useCallback(
    (event: React.SyntheticEvent): void => {
      if (!enabled) return;
      event.preventDefault();
    },
    [enabled],
  );

  return (
    <div
      className={cn(enabled && 'protected-media', className)}
      onContextMenu={block}
      onDragStart={block}
      onCopy={block}
    >
      {children}
    </div>
  );
}
