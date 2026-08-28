'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProfile, useSettings, useUpdateProfile, useUpdateSettings } from '@/hooks/use-account';
import { useSessionUser } from '@/components/providers/session-provider';
import type { SettingsDTO } from '@/services/settings';

/** One labelled switch row. The description carries the *consequence*. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-[var(--text-primary)]">
          {label}
        </Label>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function ChoiceRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-secondary)]">{label}</p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
      </div>
      <div className="w-40 shrink-0">
        <Select value={value} onValueChange={(v) => onChange(v as T)}>
          <SelectTrigger aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * Profile and preferences.
 *
 * Two different save models on purpose: toggles and choices commit on change,
 * because the effect is immediately visible and an unsaved switch is a lie.
 * The free-text profile fields commit on an explicit Save, because saving on
 * every keystroke would write a row per character and show a half-typed name to
 * the other person.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const self = useSessionUser();
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const profileQuery = useProfile();
  const updateProfile = useUpdateProfile();

  const settings = settingsQuery.data;
  const profile = profileQuery.data;

  const [displayName, setDisplayName] = React.useState('');
  const [statusText, setStatusText] = React.useState('');
  const [bio, setBio] = React.useState('');

  // Seed the form once the profile lands, and again whenever it changes on the
  // server — but never while the user is mid-edit in an open dialog.
  React.useEffect(() => {
    if (!profile || !open) return;
    setDisplayName(profile.displayName);
    setStatusText(profile.statusText ?? '');
    setBio(profile.bio ?? '');
    // Only reseed when the dialog opens or the identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.userId]);

  const set = (changes: Partial<SettingsDTO>): void => {
    updateSettings.mutate(changes, {
      onError: (error) => toast.error(error.message || 'Could not save that setting'),
    });
  };

  const dirty =
    Boolean(profile) &&
    (displayName !== profile?.displayName ||
      statusText !== (profile?.statusText ?? '') ||
      bio !== (profile?.bio ?? ''));

  const saveProfile = (): void => {
    updateProfile.mutate(
      {
        displayName: displayName.trim(),
        statusText: statusText.trim() || null,
        bio: bio.trim() || null,
      },
      {
        onSuccess: () => toast.success('Profile saved'),
        onError: (error) => toast.error(error.message || 'Could not save your profile'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85dvh]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>How you appear, and how this app behaves for you.</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="profile">
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
            <TabsTrigger value="privacy">Privacy</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="pt-4">
            <div className="mb-4 flex items-center gap-3">
              <Avatar
                size="lg"
                name={displayName || self.displayName}
                src={profile?.avatarUrl ?? self.avatarUrl}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                  @{profile?.username ?? self.username}
                </p>
                <p className="truncate text-xs text-[var(--text-muted)]">{self.email}</p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Field label="Display name">
                {({ id }) => (
                  <Input
                    id={id}
                    value={displayName}
                    maxLength={60}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="What the other person sees"
                  />
                )}
              </Field>

              <Field label="Status" hint="A short line under your name.">
                {({ id }) => (
                  <Input
                    id={id}
                    value={statusText}
                    maxLength={80}
                    onChange={(e) => setStatusText(e.target.value)}
                    placeholder="Optional"
                  />
                )}
              </Field>

              <Field label="About">
                {({ id }) => (
                  <Textarea
                    id={id}
                    value={bio}
                    maxLength={280}
                    autoResize
                    maxRows={5}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Optional"
                  />
                )}
              </Field>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!dirty || !displayName.trim()}
                  loading={updateProfile.isPending}
                  onClick={saveProfile}
                >
                  Save
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="preferences" className="pt-2">
            {settings ? (
              <div className="divide-y divide-[var(--hairline)]">
                <ChoiceRow
                  label="Theme"
                  description="System follows your device."
                  value={settings.theme}
                  onChange={(theme) => set({ theme })}
                  options={[
                    { value: 'SYSTEM', label: 'System' },
                    { value: 'LIGHT', label: 'Light' },
                    { value: 'DARK', label: 'Dark' },
                  ]}
                />
                <ChoiceRow
                  label="Text size"
                  description="Scales the whole interface, not just messages."
                  value={settings.fontSize}
                  onChange={(fontSize) => set({ fontSize })}
                  options={[
                    { value: 'SMALL', label: 'Small' },
                    { value: 'MEDIUM', label: 'Medium' },
                    { value: 'LARGE', label: 'Large' },
                    { value: 'XLARGE', label: 'Extra large' },
                  ]}
                />
                <ToggleRow
                  label="Enter sends"
                  description="Off means Enter makes a new line and you send with the button."
                  checked={settings.enterToSend}
                  onChange={(enterToSend) => set({ enterToSend })}
                />
                <ToggleRow
                  label="Reduce motion"
                  description="Stops animations regardless of your device setting."
                  checked={settings.reducedMotion}
                  onChange={(reducedMotion) => set({ reducedMotion })}
                />
                <ToggleRow
                  label="High contrast"
                  description="Stronger separators and brighter secondary text."
                  checked={settings.highContrast}
                  onChange={(highContrast) => set({ highContrast })}
                />
                <ToggleRow
                  label="Notification sound"
                  description="Plays a sound when a message arrives."
                  checked={settings.notificationSound}
                  onChange={(notificationSound) => set({ notificationSound })}
                />
              </div>
            ) : (
              <p className="py-6 text-sm text-[var(--text-muted)]">Loading…</p>
            )}
          </TabsContent>

          <TabsContent value="privacy" className="pt-2">
            {settings && profile ? (
              <div className="divide-y divide-[var(--hairline)]">
                <ToggleRow
                  label="Send read receipts"
                  description="Off means they cannot see when you have read a message — and you lose the same signal from them."
                  checked={profile.showReadReceipts}
                  onChange={(showReadReceipts) =>
                    updateProfile.mutate(
                      { showReadReceipts },
                      { onError: (e) => toast.error(e.message) },
                    )
                  }
                />
                <ToggleRow
                  label="Show last seen"
                  description="Off hides when you were last online."
                  checked={profile.showLastSeen}
                  onChange={(showLastSeen) =>
                    updateProfile.mutate({ showLastSeen }, { onError: (e) => toast.error(e.message) })
                  }
                />
                <ToggleRow
                  label="Blur media previews"
                  description="Incoming photos and videos stay blurred until you tap them."
                  checked={settings.blurNsfwPreviews}
                  onChange={(blurNsfwPreviews) => set({ blurNsfwPreviews })}
                />
                <ToggleRow
                  label="Screenshot warnings"
                  description="Tells the sender when a disappearing message may have been captured. Advisory only — a browser cannot actually prevent a screenshot."
                  checked={settings.screenshotWarnings}
                  onChange={(screenshotWarnings) => set({ screenshotWarnings })}
                />
              </div>
            ) : (
              <p className="py-6 text-sm text-[var(--text-muted)]">Loading…</p>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
