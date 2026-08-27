'use client';

import { useTheme } from 'next-themes';
import * as React from 'react';

import type { SettingsDTO } from '@/services/settings';

const FONT_SCALE: Record<SettingsDTO['fontSize'], string> = {
  SMALL: '0.9375rem',
  MEDIUM: '1rem',
  LARGE: '1.0625rem',
  XLARGE: '1.1875rem',
};

interface PreferencesContextValue {
  settings: SettingsDTO;
  /**
   * Applies a change locally and immediately. Persisting it is the caller's
   * job — the settings panel writes to the API and then calls this so the UI
   * does not wait for a round trip to reflect a toggle.
   */
  apply: (changes: Partial<SettingsDTO>) => void;
}

const PreferencesContext = React.createContext<PreferencesContextValue | null>(null);

/**
 * The user's display preferences, resolved server-side and applied to the
 * document.
 *
 * Accent colour and font size are written as CSS custom properties on
 * `<html>` rather than threaded through components: they affect hundreds of
 * elements, and a context value driving inline styles would re-render the whole
 * tree on every change.
 *
 * Theme is delegated to `next-themes` because it alone can write the class
 * before first paint. Duplicating that here would reintroduce the flash of the
 * wrong theme that the blocking script exists to prevent.
 */
export function PreferencesProvider({
  initialSettings,
  children,
}: {
  initialSettings: SettingsDTO;
  children: React.ReactNode;
}): React.JSX.Element {
  const [settings, setSettings] = React.useState<SettingsDTO>(initialSettings);
  const { setTheme } = useTheme();

  // The server is the source of truth: a settings change made on another device
  // arrives through a layout re-render and must win over local state.
  React.useEffect(() => {
    setSettings(initialSettings);
  }, [initialSettings]);

  const apply = React.useCallback((changes: Partial<SettingsDTO>): void => {
    setSettings((current) => ({ ...current, ...changes }));
  }, []);

  React.useEffect(() => {
    setTheme(settings.theme.toLowerCase());
  }, [settings.theme, setTheme]);

  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', settings.accentColor);
    root.style.setProperty('--font-size-base', FONT_SCALE[settings.fontSize]);
    root.dataset['contrast'] = settings.highContrast ? 'high' : 'normal';
    // Framer reads the OS setting through MotionConfig; this covers the
    // explicit in-app opt-in, which the OS knows nothing about.
    root.dataset['reducedMotion'] = settings.reducedMotion ? 'true' : 'false';
  }, [settings.accentColor, settings.fontSize, settings.highContrast, settings.reducedMotion]);

  const value = React.useMemo<PreferencesContextValue>(
    () => ({ settings, apply }),
    [settings, apply],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = React.useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside a PreferencesProvider');
  return context;
}
