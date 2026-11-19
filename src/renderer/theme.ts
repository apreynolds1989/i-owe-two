// Theme choice cycles System -> Light -> Dark. The page itself follows prefers-color-scheme, which
// Electron drives from the main process's nativeTheme.themeSource, so there's one source of truth.
import type { Theme } from '../shared/types';

export const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
export const THEME_LABEL: Record<Theme, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
