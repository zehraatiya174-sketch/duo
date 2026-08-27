'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Confirmation for irreversible actions — deleting for everyone, revoking a
 * device, clearing a chat.
 *
 * The dialog stays open while `onConfirm` is in flight and only closes on
 * success, so a failed delete does not silently look like it worked.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  const [pending, setPending] = React.useState(false);

  const handleConfirm = async (): Promise<void> => {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent size="sm" hideClose={pending}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={pending}
            onClick={() => void handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConfirmRequest extends Omit<ConfirmDialogProps, 'open' | 'onOpenChange' | 'onConfirm'> {
  onConfirm: () => void | Promise<void>;
}

/**
 * Imperative helper so a menu item can request confirmation without every
 * caller owning a piece of dialog state.
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => void;
  dialog: React.JSX.Element | null;
} {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);

  const dialog = request ? (
    <ConfirmDialog
      {...request}
      open
      onOpenChange={(next) => {
        if (!next) setRequest(null);
      }}
    />
  ) : null;

  return { confirm: setRequest, dialog };
}
