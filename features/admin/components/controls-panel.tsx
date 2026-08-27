'use client';

import { EyeOff, History, Timer } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAppSettings, useUpdateAppSettings } from '@/hooks/use-admin';
import { formatFull } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton, StatusDot } from './admin-shell';

/** The rules a forced-disappearing message can follow. */
const RULES = [
  { value: 'VIEW_ONCE', label: 'View once' },
  { value: 'VIEW_TWICE', label: 'View twice' },
  { value: 'UNLIMITED_TIMED', label: 'Timed — expires 24h after sending' },
] as const;

/** Matches the single `UNLIMITED_TIMED` preset offered above. */
const TIMED_EXPIRY_SECONDS = 86_400;

/**
 * Instance-wide switches.
 *
 * Disappearing Mode is the consequential one: turning it off withdraws the
 * whole conversation from both users' view. That is a hidden-state mark on the
 * settings row rather than a delete — no message, body or blob is destroyed —
 * so the panel says so plainly and offers the way back.
 */
export function ControlsPanel(): React.JSX.Element {
  const settings = useAppSettings();
  const update = useUpdateAppSettings();
  const { confirm, dialog } = useConfirm();

  const data = settings.data;
  const [rule, setRule] = React.useState<string>('VIEW_ONCE');

  // The select mirrors the server until the operator touches it.
  React.useEffect(() => {
    if (data) setRule(data.disappearingRule === 'NORMAL' ? 'VIEW_ONCE' : data.disappearingRule);
  }, [data]);

  const apply = async (enabled: boolean, nextRule: string): Promise<void> => {
    try {
      await update.mutateAsync({
        action: 'disappearing-mode',
        enabled,
        rule: nextRule,
        ...(nextRule === 'UNLIMITED_TIMED' ? { expiresInSeconds: TIMED_EXPIRY_SECONDS } : {}),
      });
      toast.success(
        enabled ? 'Disappearing Mode is on' : 'Disappearing Mode is off — history hidden',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the setting');
    }
  };

  const onToggle = (enabled: boolean): void => {
    if (enabled) {
      void apply(true, rule);
      return;
    }

    confirm({
      title: 'Turn off Disappearing Mode?',
      description:
        'Every existing message will be hidden from both accounts immediately, and new messages will stop disappearing. Nothing is deleted — the history stays on the server and you can restore it from this panel.',
      confirmLabel: 'Turn off and hide history',
      destructive: true,
      onConfirm: () => apply(false, rule),
    });
  };

  const onRestore = (): void => {
    confirm({
      title: 'Restore hidden messages?',
      description:
        'The conversation that was withdrawn from view returns for both accounts, exactly as it was.',
      confirmLabel: 'Restore',
      onConfirm: async () => {
        try {
          await update.mutateAsync({ action: 'restore-hidden' });
          toast.success('History restored');
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Could not restore the history');
        }
      },
    });
  };

  return (
    <AdminPanel
      title="Disappearing Mode"
      description="Master switch for message visibility across the whole app."
      action={
        data ? (
          <StatusDot
            tone={data.disappearingMode ? 'positive' : 'warning'}
            label={data.disappearingMode ? 'On' : 'Off'}
          />
        ) : null
      }
    >
      {settings.isLoading ? (
        <RowsSkeleton rows={3} />
      ) : settings.error ? (
        <PanelError error={settings.error} />
      ) : data ? (
        <div className="divide-y divide-[var(--hairline)]">
          <div className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <Label
                htmlFor="disappearing-mode"
                className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]"
              >
                <Timer className="size-4" aria-hidden />
                Force disappearing messages
              </Label>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                While this is on, every new message is sealed automatically — nobody has to
                remember to switch it on in the composer.
              </p>
            </div>
            <Switch
              id="disappearing-mode"
              checked={data.disappearingMode}
              disabled={update.isPending}
              onCheckedChange={onToggle}
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <Label htmlFor="disappearing-rule" className="text-sm font-medium">
                Rule applied to new messages
              </Label>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                A sender who picks their own disappearing setting keeps it; this only fills in the
                gap when they do not.
              </p>
            </div>
            <div className="w-56 shrink-0">
              <Select
                value={rule}
                onValueChange={(next) => {
                  setRule(next);
                  if (data.disappearingMode) void apply(true, next);
                }}
              >
                <SelectTrigger id="disappearing-rule" disabled={update.isPending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                {data.messagesHiddenBefore ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <History className="size-4" aria-hidden />
                )}
                Hidden history
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {data.messagesHiddenBefore
                  ? `${data.hiddenMessageCount.toLocaleString()} message${
                      data.hiddenMessageCount === 1 ? '' : 's'
                    } sent before ${formatFull(data.messagesHiddenBefore)} are withheld from both accounts. They are still on the server.`
                  : 'Nothing is being withheld. The full conversation is visible to both accounts.'}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!data.messagesHiddenBefore || update.isPending}
              loading={update.isPending}
              onClick={onRestore}
            >
              Restore
            </Button>
          </div>
        </div>
      ) : null}

      {dialog}
    </AdminPanel>
  );
}
